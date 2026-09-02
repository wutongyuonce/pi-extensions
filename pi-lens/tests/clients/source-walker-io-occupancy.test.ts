/**
 * #1137 — the SHARED async walk engine's per-directory read was synchronous.
 *
 * `walkTreeStackAsync` (clients/source-walker.ts) already `setImmediate`-yielded
 * every N entries, but every directory read still went through
 * `readDirEntriesSafe` → `fs.readdirSync`. Chunked yielding only covers the CPU
 * axis: on a cloud/network-backed tree (OneDrive) ONE stalled directory read
 * held the Node event loop — and pi's TUI — for the entire stall, no matter how
 * often the walk yielded around it. #1170 fixed exactly this shape in
 * `pipeline.ts`'s autofix snapshot walk and explicitly deferred the shared
 * engine; this is that fix, so every async walker
 * (`collectSourceFilesAsync`, `countSourceFilesWithinLimitAsync`) inherits it.
 *
 * The guard is the #902 `measureMaxSyncBlockMs` fail-then-pass screen, and it
 * targets the **I/O axis** specifically — which the existing CPU-oriented
 * `source-walk-occupancy.test.ts` cannot see, because a local `readdirSync` is
 * fast and never exhibits the stall. The same per-directory latency is injected
 * two ways: a busy-loop inside `readdirSync` (the pre-fix shape, which blocks)
 * and a timer-delayed `promises.readdir` (the converted path, which yields).
 *
 * This FAILS against pre-fix code: before the conversion `walkTreeStackAsync`
 * called the busy-looping `readdirSync` for every directory and blew the budget.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";

// `vi.spyOn(fs, "readdirSync"/"promises")` cannot redefine node:fs's ESM
// namespace exports directly, so wrap the module via vi.mock — keeps the real
// implementations (importOriginal) but makes readdirSync and promises.readdir
// individually mockable so tests can inject per-directory latency.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: vi.fn(actual.readdirSync),
		promises: { ...actual.promises, readdir: vi.fn(actual.promises.readdir) },
	};
});

import * as fs from "node:fs";
import {
	walkTreeStackAsync,
	walkTreeStackSync,
	type WalkDisposition,
} from "../../clients/source-walker.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

/** Per-directory read latency modelling a stalled cloud-backed drive. */
const INJECTED_LATENCY_MS = 60;
/** Directories in the fixture — each one pays the injected latency once. */
const DIR_COUNT = 4;

let tmpDir: string;

/** Visitor that descends into every directory and records nothing else. */
function recurseEverywhere(seen: string[]) {
	return (entry: fs.Dirent, fullPath: string): WalkDisposition => {
		seen.push(fullPath);
		return entry.isDirectory() ? "recurse" : "skip";
	};
}

beforeAll(() => {
	tmpDir = actualFs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-walk-io-"));
	// A small nested tree: the point is the number of DIRECTORY READS (each of
	// which pays the injected stall), not the file count.
	for (let d = 0; d < DIR_COUNT - 1; d++) {
		const dir = path.join(tmpDir, `d${d}`, "nested");
		actualFs.mkdirSync(dir, { recursive: true });
		actualFs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
	}
});

afterAll(() => {
	removeTempDirSync(tmpDir);
});

afterEach(() => {
	vi.mocked(fs.readdirSync).mockReset();
	vi.mocked(fs.promises.readdir).mockReset();
});

/** Busy-wait `readdirSync` — a stalled synchronous directory read. */
function installStallingSyncReaddir(): void {
	(vi.mocked(fs.readdirSync) as unknown as Mock).mockImplementation(
		(...args: unknown[]) => {
			const until = Date.now() + INJECTED_LATENCY_MS;
			while (Date.now() < until) {
				/* busy-wait: the loop is held for the whole stall */
			}
			return (actualFs.readdirSync as unknown as (...a: unknown[]) => unknown)(
				...args,
			);
		},
	);
}

/** Timer-delayed `promises.readdir` — the same stall, but off the loop. */
function installStallingAsyncReaddir(): void {
	(vi.mocked(fs.promises.readdir) as unknown as Mock).mockImplementation(
		async (...args: unknown[]) => {
			await new Promise((resolve) => setTimeout(resolve, INJECTED_LATENCY_MS));
			return (
				actualFs.promises.readdir as unknown as (...a: unknown[]) => unknown
			)(...args);
		},
	);
}

describe("shared walk engine — directory-read event-loop occupancy (#1137)", () => {
	it("walkTreeStackSync BLOCKS the loop for the per-directory stall (pre-fix shape)", async () => {
		installStallingSyncReaddir();

		const seen: string[] = [];
		const block = await measureMaxSyncBlockMs(async () => {
			walkTreeStackSync(tmpDir, recurseEverywhere(seen));
		});

		expect(seen.length).toBeGreaterThan(0);
		// The sync driver holds the loop across every stalled read back-to-back —
		// this is the regression shape the async conversion removes.
		expect(block).toBeGreaterThan(INJECTED_LATENCY_MS * 0.6);
	});

	it("walkTreeStackAsync does NOT block the loop for the same stall (converted path)", async () => {
		// Inject the SAME latency into BOTH APIs so this guard also catches a
		// revert to a synchronous per-directory read: the converted path hits the
		// (non-blocking) timer, but a revert would hit the busy-loop and blow the
		// budget.
		installStallingSyncReaddir();
		installStallingAsyncReaddir();

		const seen: string[] = [];
		const block = await measureMaxSyncBlockMs(async () => {
			await walkTreeStackAsync(tmpDir, recurseEverywhere(seen), {
				budgetMs: 8,
			});
		});

		expect(seen.length).toBeGreaterThan(0);
		// Reads happen off the loop: the longest synchronous stretch is a small
		// fraction of a single directory's stall.
		expect(block).toBeLessThan(INJECTED_LATENCY_MS * 0.5);
		// And it genuinely used the async API rather than falling back to sync.
		expect(vi.mocked(fs.promises.readdir)).toHaveBeenCalled();
		expect(vi.mocked(fs.readdirSync)).not.toHaveBeenCalled();
	});

	it("async and sync drivers visit the identical entries in the identical order", async () => {
		// Zero behaviour change is the other half of the contract: only
		// scheduling moved. No injected latency — just the real filesystem.
		(vi.mocked(fs.readdirSync) as unknown as Mock).mockImplementation(
			actualFs.readdirSync as never,
		);
		(vi.mocked(fs.promises.readdir) as unknown as Mock).mockImplementation(
			actualFs.promises.readdir as never,
		);

		const syncSeen: string[] = [];
		const asyncSeen: string[] = [];
		const syncStopped = walkTreeStackSync(tmpDir, recurseEverywhere(syncSeen));
		const asyncStopped = await walkTreeStackAsync(
			tmpDir,
			recurseEverywhere(asyncSeen),
			{ budgetMs: 0 },
		);

		expect(asyncSeen).toEqual(syncSeen);
		expect(asyncStopped).toBe(syncStopped);
	});
});
