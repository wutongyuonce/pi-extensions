/**
 * #2442: behavior-preservation for TreeCache's `recentlyEvicted` ghost-
 * eviction-history map, migrated from a hand-rolled evict-oldest Map to
 * BoundedFifoMap (`evictionHistoryMax` is constructor-injectable, so this
 * exercises the real capacity directly rather than the 4096 production
 * default). `rememberEviction` does its own delete+set to refresh recency;
 * a `get()` miss consults `recentlyEvicted` read-only (never writes it), so
 * it must never reorder eviction order.
 *
 * `this.cache` (the OTHER bounded map in this file, which retires WASM trees
 * on eviction) is a deliberate "neither" verdict in #2442 — untouched, still
 * hand-rolled — so only `recentlyEvicted`'s behavior is under test here.
 * `maxSize: 1` forces every `set()` past the first to evict from `this.cache`
 * into `recentlyEvicted`, so its own 2-entry cap is exercised directly. A
 * fake tree (`{}`) is sufficient: `retireTree` only calls `.delete()` when
 * the property exists as a function.
 */
import { describe, expect, it } from "vitest";
import { TreeCache } from "../../clients/tree-sitter-cache.js";

function fakeTree(): unknown {
	return {};
}

describe("#2442 TreeCache.recentlyEvicted (FIFO, write-refresh)", () => {
	it("evicts the single oldest ghost-history entry once filled past its own capacity", () => {
		const cache = new TreeCache(1, false, 2); // maxSize=1, evictionHistoryMax=2
		cache.set("/w/file0.ts", "content-0", "ts", fakeTree());
		cache.set("/w/file1.ts", "content-1", "ts", fakeTree()); // evicts file0 → ghost: {file0}
		cache.set("/w/file2.ts", "content-2", "ts", fakeTree()); // evicts file1 → ghost: {file0, file1}
		cache.set("/w/file3.ts", "content-3", "ts", fakeTree()); // evicts file2 → ghost cap(2) evicts file0 → ghost: {file1, file2}

		const before = cache.getStats();
		cache.get("/w/file0.ts", "content-0", "ts"); // file0's ghost entry is GONE
		cache.get("/w/file1.ts", "content-1", "ts"); // file1's ghost entry SURVIVES
		const after = cache.getStats();

		// file0: no cache entry, no ghost entry → coldMisses.
		// file1: no cache entry, but hash-matched ghost entry → capacityMisses.
		expect(after.coldMisses - before.coldMisses).toBe(1);
		expect(after.capacityMisses - before.capacityMisses).toBe(1);
	});

	it("a read (get miss) never reorders ghost-history eviction order (red on an accidental LRU substitution)", () => {
		const cache = new TreeCache(1, false, 2);
		cache.set("/w/read0.ts", "content-0", "ts", fakeTree());
		cache.set("/w/read1.ts", "content-1", "ts", fakeTree()); // ghost: {read0}
		cache.set("/w/read2.ts", "content-2", "ts", fakeTree()); // ghost: {read0, read1}

		// Repeatedly miss on read0 — an LRU ghost-history would move it to MRU
		// and it would survive the next eviction; a FIFO map must not.
		for (let i = 0; i < 5; i++) cache.get("/w/read0.ts", "content-0", "ts");

		cache.set("/w/read3.ts", "content-3", "ts", fakeTree()); // ghost cap(2) evicts read0 → ghost: {read1, read2}

		const before = cache.getStats();
		cache.get("/w/read0.ts", "content-0", "ts");
		const after = cache.getStats();
		expect(after.coldMisses - before.coldMisses).toBe(1); // evicted despite the repeat reads
		expect(after.capacityMisses - before.capacityMisses).toBe(0);
	});
});
