/**
 * #2442: behavior-preservation for `windowsCommandCache` in
 * clients/safe-spawn.ts, migrated from a hand-rolled evict-oldest Map to
 * BoundedFifoMap. Every path into `cacheWindowsCommandResult` first
 * `delete`s any stale entry for the same key (see
 * resolveWindowsCommandForEnvironment), so a re-resolution of an
 * already-cached command never grows the map — only a genuinely new cache
 * key can trigger eviction.
 *
 * Uses NEGATIVE cache entries (command not found) as the observable proxy:
 * a positive entry revalidates via `statIsFile` on EVERY hit (documented:
 * "an executable deleted or replaced mid-session cannot remain spawnable
 * through stale cache state"), so hit vs. miss both call `statSync` and
 * are not distinguishable by call count. A negative entry instead skips
 * re-stat entirely within its short TTL (`WINDOWS_COMMAND_NEGATIVE_CACHE_TTL_MS`)
 * — a cache HIT calls `statSync` zero additional times, while an evicted
 * entry (a fresh search) calls it at least once.
 *
 * Reuses the `statSyncMock` mocking pattern from
 * safe-spawn-windows-resolution.test.ts (`vi.spyOn(fs, "statSync")` cannot
 * redefine node:fs's ESM namespace export directly).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const statSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, statSync: statSyncMock };
});

import {
	WINDOWS_COMMAND_CACHE_MAX_ENTRIES,
	resetSafeSpawnWindowsCommandCache,
	resolveWindowsCommandForEnvironment,
} from "../../clients/safe-spawn.js";

const ENV = { PATH: "C:\\__pi_lens_cache_bound_tests__\\bin", PATHEXT: ".CMD" };

describe("#2442 windowsCommandCache (FIFO, negative-entry observation)", () => {
	beforeEach(() => {
		resetSafeSpawnWindowsCommandCache();
		statSyncMock.mockReset();
		statSyncMock.mockImplementation(() => {
			throw new Error("ENOENT");
		});
	});

	it("evicts the single oldest command's memo once filled past capacity", () => {
		for (let i = 0; i < WINDOWS_COMMAND_CACHE_MAX_ENTRIES; i++) {
			expect(
				resolveWindowsCommandForEnvironment(`tool-${i}`, "cwd", ENV),
			).toBeNull();
		}

		resolveWindowsCommandForEnvironment("tool-overflow", "cwd", ENV);

		// tool-1 (still cached, negative) must resolve WITHOUT a fresh statSync
		// call — a cache HIT skips re-stat entirely within the TTL.
		const callsBeforeTool1 = statSyncMock.mock.calls.length;
		resolveWindowsCommandForEnvironment("tool-1", "cwd", ENV);
		expect(statSyncMock.mock.calls.length).toBe(callsBeforeTool1);

		// tool-0 (evicted, the oldest) must trigger a fresh search.
		resolveWindowsCommandForEnvironment("tool-0", "cwd", ENV);
		expect(statSyncMock.mock.calls.length).toBeGreaterThan(callsBeforeTool1);
	});

	it("a read never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < WINDOWS_COMMAND_CACHE_MAX_ENTRIES; i++) {
			resolveWindowsCommandForEnvironment(`read-${i}`, "cwd", ENV);
		}
		// Repeatedly re-resolve the oldest (a cache HIT each time) — an LRU
		// cache would move it to MRU and it would survive the overflow below; a
		// FIFO map must not.
		for (let i = 0; i < 5; i++) {
			resolveWindowsCommandForEnvironment("read-0", "cwd", ENV);
		}

		resolveWindowsCommandForEnvironment("read-overflow", "cwd", ENV);

		// read-1 FIRST, and only then read-0. Re-resolving an evicted key
		// re-inserts it, which pushes the map over capacity again and evicts
		// the NEXT key — so checking read-1 after read-0 would observe an
		// eviction this test caused rather than the one it is asserting about.
		//
		// read-1 was never read, so under FIFO it survives: a cache HIT, zero
		// extra statSync calls. Under an LRU substitution the repeated reads
		// would have promoted read-0 and read-1 would be the eviction victim
		// instead, making this a MISS.
		const callsBeforeRead1 = statSyncMock.mock.calls.length;
		resolveWindowsCommandForEnvironment("read-1", "cwd", ENV);
		expect(statSyncMock.mock.calls.length).toBe(callsBeforeRead1);

		// The baseline is taken AFTER the overflow resolve, not before it
		// (#2442 review F4a). The overflow itself is a cache MISS and calls
		// statSync, so a baseline captured before it made this assertion
		// unconditionally true — the test passed under an LRU substitution,
		// which is the one thing it exists to catch.
		const callsAfterOverflow = statSyncMock.mock.calls.length;

		resolveWindowsCommandForEnvironment("read-0", "cwd", ENV);
		expect(statSyncMock.mock.calls.length).toBeGreaterThan(callsAfterOverflow); // evicted despite the repeat reads
	});

	it("a re-resolution of an already-cached command never grows the map (no spurious eviction on a same-key hit)", () => {
		for (let i = 0; i < WINDOWS_COMMAND_CACHE_MAX_ENTRIES; i++) {
			resolveWindowsCommandForEnvironment(`refresh-${i}`, "cwd", ENV);
		}
		// Re-resolve every already-cached command (all cache hits) — must NOT
		// evict anything, since the map never grows past its current size.
		for (let i = 0; i < WINDOWS_COMMAND_CACHE_MAX_ENTRIES; i++) {
			resolveWindowsCommandForEnvironment(`refresh-${i}`, "cwd", ENV);
		}
		const callsAfterRereads = statSyncMock.mock.calls.length;

		// refresh-0 must still resolve from cache (never evicted).
		resolveWindowsCommandForEnvironment("refresh-0", "cwd", ENV);
		expect(statSyncMock.mock.calls.length).toBe(callsAfterRereads);
	});
});
