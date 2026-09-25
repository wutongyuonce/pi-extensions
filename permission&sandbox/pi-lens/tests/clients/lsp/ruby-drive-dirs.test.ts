/**
 * #1137 — the Windows Ruby drive-root enumeration was a synchronous
 * `readdirSync(driveRoot)` run on every LSP spawn (`buildAugmentedPath`) and
 * every Ruby candidate build (`rubyBinCandidates`). On a slow cloud/network
 * backed drive root that blocks the Node event loop (and pi's TUI) for the
 * whole stall.
 *
 * These tests pin the two guarantees of the fix:
 *   1. **O(1) amortized** — the drive root is read at most once per process
 *      (memoized), across any mix of the sync and async readers.
 *   2. **Non-blocking hot path** — the async reader does NOT hold the event
 *      loop while the drive-root read is in flight, whereas the sync reader
 *      (the pre-fix code shape) does. This is the occupancy fail-then-pass
 *      screen: same injected drive-root latency, sync blocks, async doesn't.
 */

import * as fs from "node:fs";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

// `vi.spyOn(fs, "readdirSync"/"promises")` cannot redefine node:fs's ESM
// namespace exports directly, so wrap the module via vi.mock — keeps the real
// implementations (importOriginal) but makes readdirSync and promises.readdir
// individually mockable so tests can assert call counts and inject latency.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: vi.fn(actual.readdirSync),
		promises: { ...actual.promises, readdir: vi.fn(actual.promises.readdir) },
	};
});

import {
	__resetRubyDriveDirsCacheForTest,
	getRubyVersionDirNamesAsync,
	getRubyVersionDirNamesSync,
} from "../../../clients/lsp/ruby-drive-dirs.js";
import { measureMaxSyncBlockMs } from "../../support/perf-harness.js";

const DRIVE = "C:\\";
const ENTRIES = ["Ruby34-x64", "ruby3.3", "Program Files", "Windows", "temp"];
const EXPECTED = ["Ruby34-x64", "ruby3.3"];

// `readdirSync(driveRoot)` / `promises.readdir(driveRoot)` (no options) return
// `string[]`; cast the mocks loosely so tests can drive them without fighting
// node:fs's overloaded signatures.
const readdirSyncMock = vi.mocked(fs.readdirSync) as unknown as Mock;
const readdirAsyncMock = vi.mocked(fs.promises.readdir) as unknown as Mock;

afterEach(() => {
	__resetRubyDriveDirsCacheForTest();
	readdirSyncMock.mockReset();
	readdirAsyncMock.mockReset();
});

describe("ruby drive-root enumeration (#1137)", () => {
	it("sync reader filters to ruby version dirs and memoizes the drive-root read", () => {
		readdirSyncMock.mockReturnValue(ENTRIES);

		expect(getRubyVersionDirNamesSync(DRIVE)).toEqual(EXPECTED);
		expect(getRubyVersionDirNamesSync(DRIVE)).toEqual(EXPECTED);
		expect(getRubyVersionDirNamesSync(DRIVE)).toEqual(EXPECTED);
		// Memoized: the drive root is read exactly once despite three calls.
		expect(readdirSyncMock).toHaveBeenCalledTimes(1);
	});

	it("async reader filters and memoizes the drive-root read", async () => {
		readdirAsyncMock.mockResolvedValue(ENTRIES);

		await expect(getRubyVersionDirNamesAsync(DRIVE)).resolves.toEqual(EXPECTED);
		await expect(getRubyVersionDirNamesAsync(DRIVE)).resolves.toEqual(EXPECTED);
		expect(readdirAsyncMock).toHaveBeenCalledTimes(1);
	});

	it("async populate satisfies later sync reads with no drive-root readdirSync", async () => {
		readdirAsyncMock.mockResolvedValue(ENTRIES);

		await getRubyVersionDirNamesAsync(DRIVE);
		// The hot spawn path warmed the shared cache; the sync reader is a hit.
		expect(getRubyVersionDirNamesSync(DRIVE)).toEqual(EXPECTED);
		expect(readdirAsyncMock).toHaveBeenCalledTimes(1);
		expect(readdirSyncMock).not.toHaveBeenCalled();
	});

	it("shares entries across slash spellings of a Windows-shaped root", async () => {
		readdirAsyncMock.mockResolvedValue(ENTRIES);
		await getRubyVersionDirNamesAsync("C:\\Ruby");
		expect(getRubyVersionDirNamesSync("C:/Ruby")).toEqual(EXPECTED);
		expect(readdirAsyncMock).toHaveBeenCalledTimes(1);
		expect(readdirSyncMock).not.toHaveBeenCalled();
	});

	it("fails open to [] on an unreadable drive root (both readers)", async () => {
		readdirSyncMock.mockImplementation(() => {
			throw new Error("EPERM");
		});
		readdirAsyncMock.mockRejectedValue(new Error("EPERM"));

		expect(getRubyVersionDirNamesSync(DRIVE)).toEqual([]);
		__resetRubyDriveDirsCacheForTest();
		await expect(getRubyVersionDirNamesAsync(DRIVE)).resolves.toEqual([]);
	});

	// Occupancy fail-then-pass screen (#902 measureMaxSyncBlockMs pattern).
	// Same ~120ms drive-root latency injected two ways: a busy-loop inside
	// readdirSync models the pre-fix synchronous enumeration (which blocks the
	// loop), and a timer-delayed promises.readdir models the converted async
	// path (which yields). The sync path MUST block; the async path MUST NOT.
	const INJECTED_LATENCY_MS = 120;

	it("sync enumeration BLOCKS the event loop for the drive-root latency (pre-fix shape)", async () => {
		readdirSyncMock.mockImplementation(() => {
			const until = Date.now() + INJECTED_LATENCY_MS;
			while (Date.now() < until) {
				/* busy-wait: a stalled synchronous drive-root read */
			}
			return ENTRIES;
		});

		const block = await measureMaxSyncBlockMs(async () => {
			getRubyVersionDirNamesSync(DRIVE);
		});
		// The pre-fix sync enumeration holds the loop for essentially the whole
		// stall — this is the regression the async conversion removes.
		expect(block).toBeGreaterThan(INJECTED_LATENCY_MS * 0.6);
	});

	it("async enumeration does NOT block the event loop for the same latency (converted path)", async () => {
		// Inject the SAME latency into BOTH APIs so this guard also catches a
		// regression back to a synchronous drive-root read: the async path hits
		// the (non-blocking) timer, but a revert to readdirSync would hit the
		// busy-loop and blow the budget.
		readdirSyncMock.mockImplementation(() => {
			const until = Date.now() + INJECTED_LATENCY_MS;
			while (Date.now() < until) {
				/* busy-wait: a stalled synchronous drive-root read */
			}
			return ENTRIES;
		});
		readdirAsyncMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve(ENTRIES), INJECTED_LATENCY_MS);
				}),
		);

		const block = await measureMaxSyncBlockMs(async () => {
			await getRubyVersionDirNamesAsync(DRIVE);
		});
		// The converted path awaits the drive-root read off the loop: the longest
		// synchronous stretch is a tiny fraction of the injected latency.
		expect(block).toBeLessThan(INJECTED_LATENCY_MS * 0.5);
	});
});
