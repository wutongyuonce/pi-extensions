/**
 * #2442: behavior-preservation tests for the three hand-rolled
 * `keys().next().value` evict-oldest blocks in clients/project-snapshot.ts,
 * migrated to `BoundedFifoMap`. All three write paths do their own
 * `delete(key)` + `set(key, value)` to refresh recency on a re-write (a
 * cache HIT never refreshes — only a write does), so filling past capacity
 * with distinct keys must evict the single oldest key, and a `get` on a
 * still-resident key must NOT change eviction order (would red under an
 * accidental LRU substitution, since `BoundedLruCache.get()` reorders).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	PROJECT_SNAPSHOT_MAX_WARM_ROOTS,
	SNAPSHOT_PARSE_CACHE_MAX,
	_failedSnapshotPersistKeysForTests,
	_resetProjectSnapshotParseCacheForTests,
	_seedFailedSnapshotPersistForTests,
	_snapshotParseCacheGetForTests,
	_seedSnapshotParseCacheForTests,
	_seedSuccessfulSnapshotPersistForTests,
	_snapshotParseCacheKeysForTests,
	_successfulSnapshotPersistGetForTests,
	_successfulSnapshotPersistKeysForTests,
	resetProjectSnapshotPersistWorkerForTests,
} from "../../clients/project-snapshot.js";

afterEach(() => {
	_resetProjectSnapshotParseCacheForTests();
	resetProjectSnapshotPersistWorkerForTests();
});

function fill<T>(count: number, seed: (i: number) => T): void {
	for (let i = 0; i < count; i++) seed(i);
}

describe("#2442 snapshotParseCache (FIFO, write-refresh)", () => {
	it("evicts the single oldest key once filled past capacity", () => {
		fill(SNAPSHOT_PARSE_CACHE_MAX, (i) =>
			_seedSnapshotParseCacheForTests(`/repo/snap-${i}`, {
				mtimeMs: i,
				size: 1,
				snapshot: null,
			}),
		);
		expect(_snapshotParseCacheKeysForTests()).toHaveLength(
			SNAPSHOT_PARSE_CACHE_MAX,
		);
		_seedSnapshotParseCacheForTests(`/repo/snap-overflow`, {
			mtimeMs: 999,
			size: 1,
			snapshot: null,
		});
		const keys = _snapshotParseCacheKeysForTests();
		expect(keys).toHaveLength(SNAPSHOT_PARSE_CACHE_MAX);
		expect(keys).not.toContain("/repo/snap-0");
		expect(keys).toContain("/repo/snap-1");
		expect(keys).toContain("/repo/snap-overflow");
	});

	it("a write to an already-resident key refreshes recency (delete+set is the site's own touch, not the map's)", () => {
		fill(SNAPSHOT_PARSE_CACHE_MAX, (i) =>
			_seedSnapshotParseCacheForTests(`/repo/refresh-${i}`, {
				mtimeMs: i,
				size: 1,
				snapshot: null,
			}),
		);
		// Re-write the oldest key: the site's own delete+set moves it to newest.
		_seedSnapshotParseCacheForTests(`/repo/refresh-0`, {
			mtimeMs: 100,
			size: 1,
			snapshot: null,
		});
		_seedSnapshotParseCacheForTests(`/repo/refresh-overflow`, {
			mtimeMs: 200,
			size: 1,
			snapshot: null,
		});
		const keys = _snapshotParseCacheKeysForTests();
		// refresh-0 survives (it was refreshed); refresh-1 (never refreshed) is
		// now the oldest and is evicted instead.
		expect(keys).toContain("/repo/refresh-0");
		expect(keys).not.toContain("/repo/refresh-1");
	});

	it("a get of the oldest key never reorders eviction order (red on an accidental LRU substitution)", () => {
		fill(SNAPSHOT_PARSE_CACHE_MAX, (i) =>
			_seedSnapshotParseCacheForTests(`/repo/get-${i}`, {
				mtimeMs: i,
				size: 1,
				snapshot: null,
			}),
		);
		// The production READ — `snapshotParseCache.get(cacheKey)` in
		// loadProjectSnapshot — on the oldest key, BEFORE the overflow write.
		// The suite previously only looked at `.keys()`, which reorders nothing
		// under either bounded class, so every test here passed under the LRU
		// substitution they were written to catch (#2442 review F4).
		for (let i = 0; i < 5; i++) {
			expect(_snapshotParseCacheGetForTests("/repo/get-0")).toBe(true);
		}

		_seedSnapshotParseCacheForTests("/repo/get-overflow", {
			mtimeMs: 999,
			size: 1,
			snapshot: null,
		});

		const keys = _snapshotParseCacheKeysForTests();
		// FIFO: the reads left order alone, so get-0 is still oldest and goes.
		// Under LRU both assertions flip.
		expect(keys).not.toContain("/repo/get-0");
		expect(keys).toContain("/repo/get-1");
	});
});

describe("#2442 _successfulSnapshotPersists (FIFO, write-refresh)", () => {
	it("evicts the single oldest key once filled past capacity", () => {
		fill(PROJECT_SNAPSHOT_MAX_WARM_ROOTS, (i) =>
			_seedSuccessfulSnapshotPersistForTests(`/repo/persist-${i}`, {
				seq: i,
				fingerprint: `fp-${i}`,
				generatedAt: "2026-01-01",
				generation: 1,
			}),
		);
		expect(_successfulSnapshotPersistKeysForTests()).toHaveLength(
			PROJECT_SNAPSHOT_MAX_WARM_ROOTS,
		);
		_seedSuccessfulSnapshotPersistForTests("/repo/persist-overflow", {
			seq: 999,
			fingerprint: "fp-overflow",
			generatedAt: "2026-01-01",
			generation: 1,
		});
		const keys = _successfulSnapshotPersistKeysForTests();
		expect(keys).toHaveLength(PROJECT_SNAPSHOT_MAX_WARM_ROOTS);
		expect(keys).not.toContain("/repo/persist-0");
		expect(keys).toContain("/repo/persist-1");
		expect(keys).toContain("/repo/persist-overflow");
	});

	it("a get of the oldest key never reorders eviction order (red on an accidental LRU substitution)", () => {
		fill(PROJECT_SNAPSHOT_MAX_WARM_ROOTS, (i) =>
			_seedSuccessfulSnapshotPersistForTests(`/repo/get-${i}`, {
				seq: i,
				fingerprint: `fp-${i}`,
				generatedAt: "2026-01-01",
				generation: 1,
			}),
		);
		// The production read (`_successfulSnapshotPersists.get(key)`) on the
		// oldest key, before the overflow write.
		for (let i = 0; i < 5; i++) {
			expect(_successfulSnapshotPersistGetForTests("/repo/get-0")).toBe(true);
		}

		_seedSuccessfulSnapshotPersistForTests("/repo/get-overflow", {
			seq: 999,
			fingerprint: "fp-overflow",
			generatedAt: "2026-01-01",
			generation: 1,
		});

		const keys = _successfulSnapshotPersistKeysForTests();
		expect(keys).not.toContain("/repo/get-0");
		expect(keys).toContain("/repo/get-1");
	});
});

describe("#2442 _failedSnapshotPersists (FIFO, no write-refresh)", () => {
	it("evicts the single oldest key once filled past capacity", () => {
		fill(PROJECT_SNAPSHOT_MAX_WARM_ROOTS, (i) =>
			_seedFailedSnapshotPersistForTests(`/repo/failed-${i}`, {
				seq: i,
				generation: 1,
			}),
		);
		expect(_failedSnapshotPersistKeysForTests()).toHaveLength(
			PROJECT_SNAPSHOT_MAX_WARM_ROOTS,
		);
		_seedFailedSnapshotPersistForTests("/repo/failed-overflow", {
			seq: 999,
			generation: 1,
		});
		const keys = _failedSnapshotPersistKeysForTests();
		expect(keys).toHaveLength(PROJECT_SNAPSHOT_MAX_WARM_ROOTS);
		expect(keys).not.toContain("/repo/failed-0");
		expect(keys).toContain("/repo/failed-1");
		expect(keys).toContain("/repo/failed-overflow");
	});

	it("a re-record of the oldest key never reorders eviction order (red on an accidental LRU substitution)", () => {
		fill(PROJECT_SNAPSHOT_MAX_WARM_ROOTS, (i) =>
			_seedFailedSnapshotPersistForTests(`/repo/again-${i}`, {
				seq: i,
				generation: 1,
			}),
		);
		// This map has NO production `get` — `recordSnapshotPersistFailure`
		// only ever `set`s, and readers use `.delete()`. So the discriminating
		// production access is a repeat failure for an already-recorded key: a
		// bare `set`, which FIFO leaves in place and LRU promotes to newest.
		_seedFailedSnapshotPersistForTests("/repo/again-0", {
			seq: 100,
			generation: 1,
		});

		_seedFailedSnapshotPersistForTests("/repo/again-overflow", {
			seq: 999,
			generation: 1,
		});

		const keys = _failedSnapshotPersistKeysForTests();
		expect(keys).not.toContain("/repo/again-0");
		expect(keys).toContain("/repo/again-1");
	});
});
