/**
 * #2442: behavior-preservation for `sharedLineCountCache` in
 * clients/diagnostic-line-freshness.ts, migrated from a hand-rolled
 * evict-oldest Map to BoundedFifoMap. `LineCountCache` is a structural
 * interface (not `Map` itself) so `createLineCountCache()`'s test-isolated
 * instances stay plain, unbounded `Map`s while only the shared default is
 * bounded — see the interface's doc comment. `_seedSharedLineCountCacheForTests`
 * writes through the exact same `cache.set()` call `rememberInSharedCache`
 * uses, and `_sharedLineCountCacheHasForTests` is a `.has()` read that
 * bypasses `getCachedLineCount`'s real-stat requirement, so capacity eviction
 * is provable without 513 real files on disk.
 *
 * The reorder test below does NOT use that `.has()` seam: `.has()` reorders
 * nothing on `BoundedLruCache` either, so a has-based "read" could never tell
 * FIFO from LRU and the test passed under the very substitution it named
 * (#2442 review F4). The observation now runs the REAL production read —
 * `getCachedLineCount`, whose `cache.get(filePath)` is the only reordering
 * access this module makes — against a REAL temp file, so the hit path is
 * genuinely exercised (a hit needs a matching mtime AND size).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_SHARED_CACHE_ENTRIES,
	_resetSharedLineCountCacheForTests,
	_seedSharedLineCountCacheForTests,
	_sharedLineCountCacheHasForTests,
	getCachedLineCount,
} from "../../clients/diagnostic-line-freshness.js";

const tempDirs: string[] = [];

afterEach(() => {
	_resetSharedLineCountCacheForTests();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function seed(i: number, mtimeMs = i): void {
	_seedSharedLineCountCacheForTests(`/repo/file-${i}.ts`, {
		mtimeMs,
		size: 10,
		lineCount: 1,
	});
}

function realFile(name: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-line-count-"));
	tempDirs.push(dir);
	const file = path.join(dir, name);
	fs.writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
	return file;
}

describe("#2442 sharedLineCountCache (FIFO)", () => {
	it("evicts the single oldest file once filled past capacity", () => {
		for (let i = 0; i < MAX_SHARED_CACHE_ENTRIES; i++) seed(i);
		expect(_sharedLineCountCacheHasForTests("/repo/file-0.ts")).toBe(true);

		seed(MAX_SHARED_CACHE_ENTRIES); // overflow

		expect(_sharedLineCountCacheHasForTests("/repo/file-0.ts")).toBe(false);
		expect(_sharedLineCountCacheHasForTests("/repo/file-1.ts")).toBe(true);
		expect(
			_sharedLineCountCacheHasForTests(
				`/repo/file-${MAX_SHARED_CACHE_ENTRIES}.ts`,
			),
		).toBe(true);
	});

	it("a real getCachedLineCount hit never reorders eviction order (red on an accidental LRU substitution)", () => {
		// The oldest entry is a REAL file, memoized by the real production
		// write path, so the later reads below are genuine cache HITS (a hit
		// requires the re-stat's mtime AND size to match the entry).
		const oldest = realFile("oldest.ts");
		expect(getCachedLineCount(oldest)).toBe(4);
		expect(_sharedLineCountCacheHasForTests(oldest)).toBe(true);

		// Fill the rest of the capacity with synthetic entries, so `oldest` is
		// the single oldest key and the map sits exactly at capacity.
		for (let i = 1; i < MAX_SHARED_CACHE_ENTRIES; i++) seed(i);

		// The production READ, five times, on the oldest key — this is the
		// `cache.get(filePath)` inside getCachedLineCount.
		for (let i = 0; i < 5; i++) expect(getCachedLineCount(oldest)).toBe(4);

		seed(MAX_SHARED_CACHE_ENTRIES); // overflow

		// FIFO: the hits left insertion order alone, so the real file's memo is
		// still the oldest and is evicted. Under an LRU substitution BOTH flip
		// — the hits would have promoted it and file-1 would go instead.
		expect(_sharedLineCountCacheHasForTests(oldest)).toBe(false);
		expect(_sharedLineCountCacheHasForTests("/repo/file-1.ts")).toBe(true);
	});
});
