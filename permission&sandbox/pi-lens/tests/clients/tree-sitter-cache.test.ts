import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createTreeCacheCounters,
	deriveScanTreeCacheCapacity,
	TREE_CACHE_COUNTER_KEYS,
	TREE_CACHE_DEFAULT_MAX_SIZE,
	TREE_CACHE_SCAN_CAPACITY_CEILING,
	TreeCache,
	type TreeCacheCounters,
} from "../../clients/tree-sitter-cache.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

// web-tree-sitter Trees hold WASM-heap memory that JS GC does NOT reclaim — the
// cache must call tree.delete() on every removal or it leaks (#417). These use
// fake trees with a delete() spy to assert exactly-once release on each path.
// Paths are virtual: set()/get() stat the file for mtime and tolerate ENOENT.

function fakeTree() {
	return { delete: vi.fn(), rootNode: { type: "program" } };
}

async function flushRetiredTrees(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("TreeCache frees WASM trees on removal (#417)", () => {
	it("frees the oldest tree after active consumers can resume", async () => {
		const cache = new TreeCache(2);
		const a = fakeTree();
		const b = fakeTree();
		const c = fakeTree();
		cache.set("a.ts", "a", "typescript", a);
		cache.set("b.ts", "b", "typescript", b);
		cache.set("c.ts", "c", "typescript", c); // evicts oldest (a)

		expect(a.delete).not.toHaveBeenCalled();
		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).not.toHaveBeenCalled();
		expect(c.delete).not.toHaveBeenCalled();
	});

	it("frees the superseded tree when re-parsing the same file (same key)", async () => {
		const cache = new TreeCache(10);
		const old = fakeTree();
		const fresh = fakeTree();
		cache.set("x.ts", "v1", "typescript", old);
		cache.set("x.ts", "v2", "typescript", fresh); // overwrite same key

		await flushRetiredTrees();
		expect(old.delete).toHaveBeenCalledTimes(1);
		expect(fresh.delete).not.toHaveBeenCalled();
	});

	it("frees every tree on clear()", async () => {
		const cache = new TreeCache(10);
		const a = fakeTree();
		const b = fakeTree();
		cache.set("a.ts", "a", "typescript", a);
		cache.set("b.ts", "b", "typescript", b);
		cache.clear();

		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).toHaveBeenCalledTimes(1);
	});

	it("does NOT free the tree when content changed (a reader may still hold it)", () => {
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set("a.ts", "original", "typescript", a);
		// Different content ⇒ cache miss, but the entry is retained until the next
		// set() replaces it — it must not be deleted out from under a live reader.
		const hit = cache.get("a.ts", "changed content", "typescript");

		expect(hit).toBeNull();
		expect(a.delete).not.toHaveBeenCalled();
	});

	it("never double-frees an already-evicted tree", async () => {
		const cache = new TreeCache(1);
		const a = fakeTree();
		const b = fakeTree();
		cache.set("a.ts", "a", "typescript", a); // a cached
		cache.set("b.ts", "b", "typescript", b); // evicts a → a freed once
		cache.clear(); // frees b only; a is gone

		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the tree when a content-less lookup sees a newer mtime", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-mtime-");
		cleanups.push(env.cleanup);
		const src = "export const x = 1;\n";
		const file = createTempFile(env.tmpDir, "m.ts", src);
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set(file, src, "typescript", a);

		// Without content to hash, mtime is the only freshness proof: a bump
		// invalidates + frees (#890). (With content, the SAME bump is a hit —
		// see the save-without-change test below.)
		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);

		expect(cache.get(file, undefined, "typescript")).toBeNull();
		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the tree when the file was deleted on disk", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-del-");
		cleanups.push(env.cleanup);
		const src = "export const y = 2;\n";
		const file = createTempFile(env.tmpDir, "d.ts", src);
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set(file, src, "typescript", a);

		fs.rmSync(file);

		expect(cache.get(file, src, "typescript")).toBeNull();
		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
	});

	it("survives a tree whose delete() throws (dead/aborted runtime)", async () => {
		const cache = new TreeCache(1);
		const boom = {
			delete: vi.fn(() => {
				throw new Error("Aborted()");
			}),
		};
		const next = fakeTree();
		cache.set("a.ts", "a", "typescript", boom);
		expect(() => cache.set("b.ts", "b", "typescript", next)).not.toThrow();
		await flushRetiredTrees();
		expect(boom.delete).toHaveBeenCalledTimes(1);
	});
});

describe("TreeSitterClient query-cache Tier-2 bounds (#1389)", () => {
	it("evicts the LRU on the ninth insert and rebuilds after a miss", async () => {
		const previous = process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP;
		process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP = "8";
		try {
			const { TreeSitterClient } =
				await import("../../clients/tree-sitter-client.js");
			const client = new TreeSitterClient() as any;
			const values = Array.from({ length: 9 }, (_, i) => ({
				query: { delete: vi.fn() },
				i,
			}));
			for (let i = 0; i < 8; i++) client.cacheQuery(`q${i}`, values[i]);
			client.queryCache.get("q0");
			client.queryCache.delete("q0");
			client.queryCache.set("q0", values[0]);
			client.cacheQuery("q8", values[8]);
			expect(client.queryCache.has("q0")).toBe(true);
			expect(client.queryCache.has("q1")).toBe(false);
			client.cacheQuery("q1", values[1]);
			expect(client.queryCache.has("q1")).toBe(true);
			expect(values[1].query.delete).toHaveBeenCalledTimes(1);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP;
			else process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP = previous;
		}
	});
});

describe("TreeCache hash-authoritative hits and true LRU (#890)", () => {
	it("treats a save-without-change (same hash, newer mtime) as a hit with no reparse", () => {
		const env = setupTestEnvironment("pi-lens-tccache-save-");
		cleanups.push(env.cleanup);
		const src = "export const x = 1;\n";
		const file = createTempFile(env.tmpDir, "s.ts", src);
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set(file, src, "typescript", a);

		// Agent re-saves identical bytes ⇒ mtime bumps, content unchanged.
		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);

		// Hash is authoritative: the SAME tree comes back (no reparse) and
		// nothing is retired.
		expect(cache.get(file, src, "typescript")).toBe(a);
		expect(a.delete).not.toHaveBeenCalled();
		expect(cache.getStats()).toMatchObject({
			hits: 1,
			misses: 0,
			mtimeMisses: 0,
		});

		// Metadata was refreshed on the hit: a content-less lookup (mtime is
		// its only freshness proof) also hits instead of mtime-missing.
		expect(cache.get(file, undefined, "typescript")).toBe(a);
		expect(cache.getStats()).toMatchObject({ hits: 2, mtimeMisses: 0 });
	});

	it("protects a recently-read entry from eviction by later inserts (true LRU)", async () => {
		// Real files: a hash-matched hit stats the file, and a stat failure
		// invalidates (virtual paths would miss on stat, not exercise the LRU
		// touch).
		const env = setupTestEnvironment("pi-lens-tccache-lru-");
		cleanups.push(env.cleanup);
		const fileA = createTempFile(env.tmpDir, "a.ts", "a");
		const fileB = createTempFile(env.tmpDir, "b.ts", "b");
		const fileC = createTempFile(env.tmpDir, "c.ts", "c");
		const cache = new TreeCache(2);
		const a = fakeTree();
		const b = fakeTree();
		const c = fakeTree();
		cache.set(fileA, "a", "typescript", a); // oldest insertion
		cache.set(fileB, "b", "typescript", b);

		// Touch a ⇒ it becomes the newest entry; b is now the LRU one.
		expect(cache.get(fileA, "a", "typescript")).toBe(a);

		cache.set(fileC, "c", "typescript", c); // evicts LRU = b, NOT a

		expect(cache.get(fileA, "a", "typescript")).toBe(a); // survived
		expect(cache.get(fileB, "b", "typescript")).toBeNull(); // evicted
		expect(cache.getStats()).toMatchObject({
			evictions: 1,
			capacityMisses: 1, // ghost history recognizes the same-content miss
		});

		// The LRU touch re-inserts the SAME entry — it must not retire a's
		// tree, and the evicted tree is freed exactly once (no double-retire).
		await flushRetiredTrees();
		expect(a.delete).not.toHaveBeenCalled();
		expect(b.delete).toHaveBeenCalledTimes(1);
		expect(c.delete).not.toHaveBeenCalled();
	});

	it("still retires a genuinely replaced tree after a hash-match metadata refresh", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-refresh-");
		cleanups.push(env.cleanup);
		const src = "export const x = 1;\n";
		const file = createTempFile(env.tmpDir, "r.ts", src);
		const cache = new TreeCache(10);
		const old = fakeTree();
		const fresh = fakeTree();
		cache.set(file, src, "typescript", old);

		// Save-without-change hit refreshes metadata on the old entry...
		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);
		expect(cache.get(file, src, "typescript")).toBe(old);

		// ...and a genuine re-parse of the same key must still retire the old
		// tree exactly once — the metadata refresh must not swallow it.
		cache.set(file, `${src}// v2`, "typescript", fresh);
		await flushRetiredTrees();
		expect(old.delete).toHaveBeenCalledTimes(1);
		expect(fresh.delete).not.toHaveBeenCalled();
	});
});

describe("TreeCache statistics (#675)", () => {
	it("tracks cold, content-changed, mtime, and stat-failure misses", () => {
		const env = setupTestEnvironment("pi-lens-tccache-stats-");
		cleanups.push(env.cleanup);
		const source = "export const x = 1;\n";
		const file = createTempFile(env.tmpDir, "stats.ts", source);
		const cache = new TreeCache(10);

		expect(cache.get(file, source, "typescript")).toBeNull();
		cache.set(file, source, "typescript", fakeTree());
		expect(cache.get(file, source, "typescript")).not.toBeNull();
		expect(cache.get(file, `${source}// changed`, "typescript")).toBeNull();

		// Same content + newer mtime is a hash-authoritative HIT (#890)...
		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);
		expect(cache.get(file, source, "typescript")).not.toBeNull();
		// ...and an mtime miss is only reachable on the content-less path.
		const later = new Date(Date.now() + 10000);
		fs.utimesSync(file, later, later);
		expect(cache.get(file, undefined, "typescript")).toBeNull();

		const deleted = createTempFile(env.tmpDir, "deleted.ts", source);
		cache.set(deleted, source, "typescript", fakeTree());
		fs.rmSync(deleted);
		expect(cache.get(deleted, source, "typescript")).toBeNull();

		expect(cache.getStats()).toMatchObject({
			lookups: 6,
			hits: 2,
			misses: 4,
			coldMisses: 1,
			contentChangedMisses: 1,
			mtimeMisses: 1,
			statFailedMisses: 1,
		});
	});

	it("distinguishes a same-content reload after capacity eviction", () => {
		const cache = new TreeCache(1);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());

		expect(cache.get("a.ts", "a", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			lookups: 1,
			misses: 1,
			coldMisses: 0,
			capacityMisses: 1,
			evictions: 1,
		});
	});

	it("drops eviction ghosts on clear() so the next miss reads as cold", () => {
		const cache = new TreeCache(1);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());
		cache.clear();

		expect(cache.get("a.ts", "a", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			coldMisses: 1,
			capacityMisses: 0,
		});
	});

	it("normalizes path separators in cache keys", () => {
		const cache = new TreeCache(2);
		cache.set("dir\\a.ts", "a", "typescript", fakeTree());

		// Same file, other separator: the key MATCHES (so the miss is the on-disk
		// stat failing, not a cold lookup against a different key).
		expect(cache.get("dir/a.ts", "a", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			coldMisses: 0,
			statFailedMisses: 1,
		});
	});

	it("bounds eviction history and reports dropped keys", () => {
		const cache = new TreeCache(1, false, 1);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());
		cache.set("c.ts", "c", "typescript", fakeTree());

		expect(cache.get("a.ts", "a", "typescript")).toBeNull();
		expect(cache.get("b.ts", "b", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			coldMisses: 1,
			capacityMisses: 1,
			ghostHistoryDrops: 1,
		});
	});

	it("reports UTF-8 resident source bytes", () => {
		const cache = new TreeCache(2);
		cache.set("unicode.ts", "é\n", "typescript", fakeTree());

		expect(cache.getStats().totalBytes).toBe(3);
	});

	it("tracks replacement and clear operations", () => {
		const cache = new TreeCache(2);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());
		cache.set("a.ts", "updated", "typescript", fakeTree());
		cache.clear();

		expect(cache.getStats()).toMatchObject({
			sets: 3,
			replacements: 1,
			clears: 1,
			size: 0,
		});
	});

	it("distinguishes cold vs capacity misses (#1715 pin — the measurement #890's stats enable)", () => {
		// Pinned separately from the #890 test above: this is the exact
		// distinction #1715's dogfood measurement read off cache_stats to prove
		// EVERY second-scan miss was capacity-bound, not cold. If this
		// distinction ever collapsed, that live measurement would stop being
		// possible.
		const cache = new TreeCache(1);
		cache.set("a.ts", "a", "typescript", fakeTree()); // first scan: cold
		cache.set("b.ts", "b", "typescript", fakeTree()); // evicts a (capacity-bound)

		expect(cache.get("z.ts", "z", "typescript")).toBeNull(); // never seen: cold
		expect(cache.get("a.ts", "a", "typescript")).toBeNull(); // evicted, same content: capacity

		expect(cache.getStats()).toMatchObject({
			coldMisses: 1,
			capacityMisses: 1,
		});
	});
});

describe("TreeCache capacity growth for scan working sets (#1715)", () => {
	it("cannot span a full-scan working set at the interactive default — every second-scan lookup is a capacityMiss", () => {
		// Documents the bug this issue reports: a fixed 50-entry cache asked to
		// hold a 110-file working set evicts the tail, so a second identical
		// scan re-parses everything the LRU couldn't keep.
		const env = setupTestEnvironment("pi-lens-tccache-nospan-");
		cleanups.push(env.cleanup);
		const cache = new TreeCache(TREE_CACHE_DEFAULT_MAX_SIZE);
		const fileCount = 110;
		const files = Array.from({ length: fileCount }, (_, i) =>
			createTempFile(env.tmpDir, `f${i}.ts`, `content-${i}`),
		);
		for (let i = 0; i < fileCount; i++) {
			cache.set(files[i], `content-${i}`, "typescript", fakeTree());
		}
		expect(cache.getStats().size).toBe(TREE_CACHE_DEFAULT_MAX_SIZE);

		let misses = 0;
		for (let i = 0; i < fileCount; i++) {
			if (cache.get(files[i], `content-${i}`, "typescript") === null) misses++;
		}
		// The first 60 of 110 files were evicted to make room for the last 50 —
		// EVERY miss on this second pass is capacity-bound, none cold or
		// stat-failed (all files exist with matching content).
		expect(misses).toBe(fileCount - TREE_CACHE_DEFAULT_MAX_SIZE);
		expect(cache.getStats()).toMatchObject({
			capacityMisses: fileCount - TREE_CACHE_DEFAULT_MAX_SIZE,
			coldMisses: 0,
			statFailedMisses: 0,
		});
	});

	it("setMaxSize grows capacity without evicting or freeing existing entries", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-grow-");
		cleanups.push(env.cleanup);
		const fileA = createTempFile(env.tmpDir, "a.ts", "a");
		const fileB = createTempFile(env.tmpDir, "b.ts", "b");
		const cache = new TreeCache(2);
		const a = fakeTree();
		const b = fakeTree();
		cache.set(fileA, "a", "typescript", a);
		cache.set(fileB, "b", "typescript", b);

		cache.setMaxSize(10);
		await flushRetiredTrees();

		expect(cache.getStats().maxSize).toBe(10);
		expect(a.delete).not.toHaveBeenCalled();
		expect(b.delete).not.toHaveBeenCalled();
		expect(cache.get(fileA, "a", "typescript")).toBe(a);
		expect(cache.get(fileB, "b", "typescript")).toBe(b);
	});

	it("setMaxSize shrinking evicts the LRU tail AND frees each dropped tree (#417 discipline under the new lifetime)", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-shrink-");
		cleanups.push(env.cleanup);
		const fileA = createTempFile(env.tmpDir, "a.ts", "a");
		const fileB = createTempFile(env.tmpDir, "b.ts", "b");
		const fileC = createTempFile(env.tmpDir, "c.ts", "c");
		const cache = new TreeCache(3);
		const a = fakeTree();
		const b = fakeTree();
		const c = fakeTree();
		cache.set(fileA, "a", "typescript", a);
		cache.set(fileB, "b", "typescript", b);
		cache.set(fileC, "c", "typescript", c);

		cache.setMaxSize(1); // must evict+free a and b (LRU order), keep c
		await flushRetiredTrees();

		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).toHaveBeenCalledTimes(1);
		expect(c.delete).not.toHaveBeenCalled();
		expect(cache.getStats().size).toBe(1);
		expect(cache.get(fileC, "c", "typescript")).toBe(c);
	});

	it("constructor floors maxSize at 1 (0 does not evict the just-inserted tree, #2442 round-3 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-zerofloor-");
		cleanups.push(env.cleanup);
		const fileA = createTempFile(env.tmpDir, "a.ts", "a");
		const cache = new TreeCache(0);
		const a = fakeTree();
		cache.set(fileA, "a", "typescript", a);
		await flushRetiredTrees();

		expect(cache.getStats().maxSize).toBe(1);
		expect(a.delete).not.toHaveBeenCalled();
		expect(cache.get(fileA, "a", "typescript")).toBe(a);
	});

	it("after growing to span the working set, a second identical scan sees zero capacityMisses", () => {
		const env = setupTestEnvironment("pi-lens-tccache-scanreuse-");
		cleanups.push(env.cleanup);
		const cache = new TreeCache(TREE_CACHE_DEFAULT_MAX_SIZE);
		const fileCount = 110;
		const files = Array.from({ length: fileCount }, (_, i) =>
			createTempFile(env.tmpDir, `f${i}.ts`, `content-${i}`),
		);
		cache.setMaxSize(
			deriveScanTreeCacheCapacity(fileCount, cache.getMaxSize()),
		);

		for (let i = 0; i < fileCount; i++) {
			cache.set(files[i], `content-${i}`, "typescript", fakeTree());
		}
		expect(cache.getStats().size).toBe(fileCount);

		let hits = 0;
		for (let i = 0; i < fileCount; i++) {
			if (cache.get(files[i], `content-${i}`, "typescript") !== null) hits++;
		}

		expect(hits).toBe(fileCount);
		expect(cache.getStats()).toMatchObject({
			capacityMisses: 0,
			coldMisses: 0,
		});
	});

	describe("deriveScanTreeCacheCapacity", () => {
		const previousEnv = process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP;
		afterEach(() => {
			if (previousEnv === undefined) {
				delete process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP;
			} else {
				process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP = previousEnv;
			}
		});

		it("targets the file count when it fits under the ceiling", () => {
			delete process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP;
			expect(
				deriveScanTreeCacheCapacity(110, TREE_CACHE_DEFAULT_MAX_SIZE),
			).toBe(110);
		});

		it("never targets below the interactive default, even for a tiny scan", () => {
			delete process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP;
			expect(deriveScanTreeCacheCapacity(3, TREE_CACHE_DEFAULT_MAX_SIZE)).toBe(
				TREE_CACHE_DEFAULT_MAX_SIZE,
			);
		});

		it("clamps at the hard ceiling for a huge project (bounds the heap, not just the count)", () => {
			delete process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP;
			expect(
				deriveScanTreeCacheCapacity(50_000, TREE_CACHE_DEFAULT_MAX_SIZE),
			).toBe(TREE_CACHE_SCAN_CAPACITY_CEILING);
		});

		it("never shrinks a capacity the cache already has", () => {
			delete process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP;
			expect(deriveScanTreeCacheCapacity(10, 300)).toBe(300);
		});

		it("respects an operator's PI_LENS_TREE_SITTER_CACHE_SCAN_CAP override", () => {
			process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP = "75";
			expect(
				deriveScanTreeCacheCapacity(1000, TREE_CACHE_DEFAULT_MAX_SIZE),
			).toBe(75);
		});

		it("ignores a malformed override and falls back to the hard ceiling", () => {
			process.env.PI_LENS_TREE_SITTER_CACHE_SCAN_CAP = "not-a-number";
			expect(
				deriveScanTreeCacheCapacity(50_000, TREE_CACHE_DEFAULT_MAX_SIZE),
			).toBe(TREE_CACHE_SCAN_CAPACITY_CEILING);
		});
	});

	it("N repeated scans at the grown capacity keep the resident tree count bounded and free every superseded tree exactly once (no leak under the new lifetime)", async () => {
		const cache = new TreeCache(TREE_CACHE_DEFAULT_MAX_SIZE);
		const fileCount = 110;
		const scans = 5;
		cache.setMaxSize(
			deriveScanTreeCacheCapacity(fileCount, cache.getMaxSize()),
		);

		const treesByScan: ReturnType<typeof fakeTree>[][] = [];
		for (let scan = 0; scan < scans; scan++) {
			const trees: ReturnType<typeof fakeTree>[] = [];
			for (let i = 0; i < fileCount; i++) {
				const tree = fakeTree();
				trees.push(tree);
				// Content changes every scan so each set() is a genuine
				// same-key replacement, not a hash-authoritative hit — the
				// path that must free the superseded tree.
				cache.set(`f${i}.ts`, `content-${i}-scan${scan}`, "typescript", tree);
			}
			treesByScan.push(trees);
			await flushRetiredTrees();
			// Bounded: the resident set never grows past the capacity, scan
			// after scan — the defining property of a leak-free lifetime.
			expect(cache.getStats().size).toBe(fileCount);
		}

		// Every superseded scan's trees were freed exactly once...
		for (let scan = 0; scan < scans - 1; scan++) {
			for (const tree of treesByScan[scan]) {
				expect(tree.delete).toHaveBeenCalledTimes(1);
			}
		}
		// ...and the final scan's trees are still live (not double-freed, not
		// dropped out from under the resident cache).
		for (const tree of treesByScan[scans - 1]) {
			expect(tree.delete).not.toHaveBeenCalled();
		}
	});

	// #1935: growing the cache to fit a scan's working set trades a bigger
	// entry-count ceiling for more resident memory — `treeCacheTotalBytes`
	// (the source-byte sum `memory_sample` reports, `getStats().totalBytes`
	// here) must stay a bounded number, not climb without limit as a project
	// grows past the cache's capacity. `TREE_CACHE_SCAN_CAPACITY_CEILING`
	// (500 entries) is the enforcement point: this test offers far more files
	// than the ceiling and pins that resident bytes stay bounded by realistic
	// per-file sizes, proving the entry-count cap also bounds bytes.
	it("bounds treeCacheTotalBytes at the scan ceiling using realistic, varying per-file sizes (#1935)", () => {
		const cache = new TreeCache(TREE_CACHE_DEFAULT_MAX_SIZE);
		// Realistic per-file source sizes observed in production (#1935 review
		// round): 12.4KB-36KB, not one repeated size. A uniform fixture makes
		// the byte assertion arithmetically forced by the entry-count
		// assertion (every entry contributes the same amount, so the total is
		// just `size * perFileBytes` and can't fail independently) and
		// understates the real worst case. Cycle through a deterministic,
		// non-uniform spread so the resident-byte sum carries information the
		// entry-count assertion above doesn't already give away.
		const minFileBytes = 12_400;
		const maxFileBytes = 36_000;
		const span = maxFileBytes - minFileBytes;
		const sizeFor = (i: number): number =>
			minFileBytes + Math.floor((span * ((i * 37) % 101)) / 100);

		// A project many times larger than the hard ceiling — e.g. a 1500-file
		// monorepo — so the cache must evict, not just grow unboundedly.
		const totalFilesOffered = TREE_CACHE_SCAN_CAPACITY_CEILING * 3;
		cache.setMaxSize(
			deriveScanTreeCacheCapacity(totalFilesOffered, cache.getMaxSize()),
		);
		expect(cache.getMaxSize()).toBe(TREE_CACHE_SCAN_CAPACITY_CEILING);

		const sizesOffered: number[] = [];
		for (let i = 0; i < totalFilesOffered; i++) {
			const bytes = sizeFor(i);
			sizesOffered.push(bytes);
			cache.set(`f${i}.ts`, "x".repeat(bytes), "typescript", fakeTree());
		}

		const stats = cache.getStats();
		expect(stats.size).toBe(TREE_CACHE_SCAN_CAPACITY_CEILING);

		// Eviction here is pure FIFO (no `get()` re-insertions reorder
		// recency), so the resident set is exactly the LAST `ceiling` entries
		// offered. Sum their sizes independently of the varying-size fixture
		// above: this fails on its own if eviction keeps the wrong entries,
		// double-counts, or the cap is missing entirely.
		const expectedResidentBytes = sizesOffered
			.slice(-TREE_CACHE_SCAN_CAPACITY_CEILING)
			.reduce((sum, bytes) => sum + bytes, 0);
		expect(stats.totalBytes).toBe(expectedResidentBytes);

		// Blast radius (#1935 review): `TreeCache` enforces NO per-entry byte
		// cap — only the entry-count ceiling (`fileSize` is accounted, never
		// limited). At these realistic per-file sizes the 500-entry ceiling
		// means 6-18MB of resident source bytes worst case, not the ~1.8MB a
		// uniform ~3.6KB fixture would have implied. State the range plainly
		// rather than let the fixture understate it.
		const worstCaseFloor = TREE_CACHE_SCAN_CAPACITY_CEILING * minFileBytes;
		const worstCaseCeiling = TREE_CACHE_SCAN_CAPACITY_CEILING * maxFileBytes;
		expect(stats.totalBytes).toBeGreaterThanOrEqual(worstCaseFloor);
		expect(stats.totalBytes).toBeLessThanOrEqual(worstCaseCeiling);
	});
});

// #1727/#1777: `createTreeCacheCounters` builds its result with
// `Object.fromEntries(...) as unknown as TreeCacheCounters`. Its SAFETY
// comment claims the cast holds because TREE_CACHE_COUNTER_KEYS covers every
// counter. The `as const satisfies readonly (keyof TreeCacheCounters)[]`
// clause on that array only checks one direction — that no listed key is
// bogus. Nothing checked the reverse until now: add a counter to the
// interface and forget the array, and the cast silently starts lying.
describe("tree cache counter keys cover the counter type (#1727)", () => {
	it("has no counter missing from TREE_CACHE_COUNTER_KEYS", () => {
		// This assertion is COMPILE-TIME only; the `expect` below just gives
		// vitest a body. `MissingCounterKey` is `never` exactly while every key
		// of TreeCacheCounters appears in the array.
		type MissingCounterKey = Exclude<
			keyof TreeCacheCounters,
			(typeof TREE_CACHE_COUNTER_KEYS)[number]
		>;
		// The `[T] extends [never]` wrapper is load-bearing. The obvious form,
		// `const missing: MissingCounterKey[] = []`, is VACUOUS: an empty array
		// literal is assignable to an array of ANY element type, so it compiles
		// even when MissingCounterKey is a real key. This form resolves to
		// `never` — which nothing can be assigned to — the moment a counter is
		// missing, so `tsc` fails with TS2322. Verified by mutation: dropping
		// `ghostHistoryDrops` from TREE_CACHE_COUNTER_KEYS reds this line and
		// leaves the vacuous form green.
		const _noMissing: [MissingCounterKey] extends [never] ? true : never = true;
		expect(_noMissing).toBe(true);
	});

	it("seeds every declared key as a numeric zero", () => {
		// Deliberately NOT a key-coverage check: both sides of a key comparison
		// would come from TREE_CACHE_COUNTER_KEYS, which proves nothing. Key
		// coverage is the compile-time assertion above. What this pins is the
		// part of the cast that is a runtime claim — that `Object.fromEntries`
		// produced one entry per key and every value is the number 0, not
		// `undefined` or a string.
		const counters = createTreeCacheCounters();
		const values = Object.values(counters);
		expect(values).toHaveLength(TREE_CACHE_COUNTER_KEYS.length);
		expect(values.every((v) => typeof v === "number" && v === 0)).toBe(true);
	});
});
