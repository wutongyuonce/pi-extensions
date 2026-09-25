import { describe, expect, it } from "vitest";
import {
	BoundedFifoMap,
	BoundedLruCache,
	BoundedSet,
} from "../../clients/bounded-cache.js";

describe("BoundedLruCache", () => {
	it("evicts the least recently used entry and allows recovery", () => {
		const cache = new BoundedLruCache<string, string>(2);
		cache.set("a", "one");
		cache.set("b", "two");
		expect(cache.get("a")).toBe("one");
		cache.set("c", "three");
		expect(cache.get("b")).toBeUndefined();
		cache.set("b", "rebuilt");
		expect(cache.get("b")).toBe("rebuilt");
	});

	it("refreshes recency on read", () => {
		const cache = new BoundedLruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
	});

	it("set() returns the evicted [key, value] pairs, oldest first", () => {
		const cache = new BoundedLruCache<string, number>(2);
		expect(cache.set("a", 1)).toEqual([]);
		expect(cache.set("b", 2)).toEqual([]);
		// The VALUE comes back too (#2442 review F7): tree-sitter-cache has to
		// retire the evicted entry's WASM tree and tree-sitter-client has to
		// delete() the evicted compiled query, and neither can read a value out
		// of a map the eviction has already emptied.
		expect(cache.set("c", 3)).toEqual([["a", 1]]);
	});

	it("setMaxEntries() shrinks immediately and reports what it dropped", () => {
		const cache = new BoundedLruCache<string, number>(4);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		// Growing changes only the bound.
		expect(cache.setMaxEntries(8)).toEqual([]);
		expect(cache.getMaxEntries()).toBe(8);
		expect(cache.size).toBe(3);
		// Shrinking evicts oldest-first down to the new ceiling and hands back
		// every dropped pair, so a caller with a dynamic cap (TreeCache's
		// setMaxSize, tree-sitter-client's env-read ceiling) still frees the
		// resources those entries owned.
		expect(cache.setMaxEntries(1)).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect(cache.getMaxEntries()).toBe(1);
		expect(cache.entriesArray()).toEqual([["c", 3]]);
	});
});

describe("BoundedFifoMap (#2442)", () => {
	it("evicts the oldest INSERTION (not the least recently used) and allows recovery", () => {
		const map = new BoundedFifoMap<string, string>(2);
		map.set("a", "one");
		map.set("b", "two");
		// A read must NOT refresh recency — "a" stays the oldest even though it
		// was just read, unlike BoundedLruCache.
		expect(map.get("a")).toBe("one");
		map.set("c", "three");
		expect(map.get("a")).toBeUndefined(); // evicted despite the read above
		expect(map.get("b")).toBe("two"); // survives: it was never read, but
		// insertion order (not read order) is what matters for FIFO
		map.set("b", "rebuilt");
		expect(map.get("b")).toBe("rebuilt");
	});

	it("get() never re-inserts (insertion order stays eviction order)", () => {
		const map = new BoundedFifoMap<string, number>(2);
		map.set("a", 1);
		map.set("b", 2);
		for (let i = 0; i < 5; i++) map.get("a"); // repeated reads
		map.set("c", 3); // "a" is still the oldest insertion — evicted
		expect(map.has("a")).toBe(false);
		expect(map.has("b")).toBe(true);
	});

	it("set() on an already-present key updates in place without reordering (matches native Map#set)", () => {
		const map = new BoundedFifoMap<string, number>(3);
		map.set("a", 1);
		map.set("b", 2);
		map.set("c", 3);
		map.set("a", 100); // update, not append — "a" stays the oldest position
		map.set("d", 4); // pushes past capacity — evicts the oldest: "a"
		expect(map.has("a")).toBe(false);
		expect(map.get("b")).toBe(2);
		expect(map.get("c")).toBe(3);
		expect(map.get("d")).toBe(4);
	});

	it("set() returns the evicted [key, value] pairs, oldest first", () => {
		const map = new BoundedFifoMap<string, number>(2);
		expect(map.set("a", 1)).toEqual([]);
		expect(map.set("b", 2)).toEqual([]);
		expect(map.set("c", 3)).toEqual([["a", 1]]);
	});

	it("setMaxEntries() shrinks immediately and reports what it dropped", () => {
		const map = new BoundedFifoMap<string, number>(4);
		map.set("a", 1);
		map.set("b", 2);
		map.set("c", 3);
		expect(map.setMaxEntries(8)).toEqual([]);
		expect(map.size).toBe(3);
		expect(map.setMaxEntries(2)).toEqual([["a", 1]]);
		expect(map.getMaxEntries()).toBe(2);
		expect(map.entriesArray()).toEqual([
			["b", 2],
			["c", 3],
		]);
	});

	it("BoundedLruCache IS a BoundedFifoMap, differing only in get and set", () => {
		// #2442 review F3: the two classes shipped as near-identical copies
		// (Sonar flagged 10.6% duplication on the file). BoundedLruCache now
		// extends BoundedFifoMap and overrides exactly the two methods that
		// differ, so eviction, capacity and the whole Map surface have ONE
		// implementation. A new own-property on the subclass means a behavior
		// fork that belongs in the base class instead.
		const lru = new BoundedLruCache<string, number>(2);
		expect(lru).toBeInstanceOf(BoundedFifoMap);
		expect(
			Object.getOwnPropertyNames(BoundedLruCache.prototype).sort(),
		).toEqual(["constructor", "get", "set"]);
	});

	it("has/delete/clear/size/entriesArray behave as a bounded Map", () => {
		const map = new BoundedFifoMap<string, number>(5);
		map.set("a", 1);
		map.set("b", 2);
		expect(map.size).toBe(2);
		expect(map.has("a")).toBe(true);
		expect(map.entriesArray()).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect(map.delete("a")).toBe(true);
		expect(map.has("a")).toBe(false);
		expect(map.size).toBe(1);
		map.clear();
		expect(map.size).toBe(0);
	});
});

describe("BoundedSet (#2460)", () => {
	it("evicts the oldest INSERTION once the set exceeds capacity", () => {
		const set = new BoundedSet<string>(2);
		set.add("a");
		set.add("b");
		expect(set.has("a")).toBe(true);
		set.add("c");
		expect(set.has("a")).toBe(false); // oldest, evicted
		expect(set.has("b")).toBe(true);
		expect(set.has("c")).toBe(true);
	});

	it("has() does not refresh recency — a read never postpones eviction", () => {
		const set = new BoundedSet<string>(2);
		set.add("a");
		set.add("b");
		for (let i = 0; i < 5; i++) set.has("a"); // repeated reads
		set.add("c"); // "a" is still the oldest insertion — evicted
		expect(set.has("a")).toBe(false);
		expect(set.has("b")).toBe(true);
	});

	it("add() on an already-present member does not reorder it (matches native Set#add)", () => {
		const set = new BoundedSet<string>(3);
		set.add("a");
		set.add("b");
		set.add("c");
		set.add("a"); // re-add — "a" stays the oldest position
		set.add("d"); // pushes past capacity — evicts the oldest: "a"
		expect(set.has("a")).toBe(false);
		expect(set.has("b")).toBe(true);
		expect(set.has("c")).toBe(true);
		expect(set.has("d")).toBe(true);
	});

	it("add() returns the evicted values, oldest first", () => {
		const set = new BoundedSet<string>(2);
		expect(set.add("a")).toEqual([]);
		expect(set.add("b")).toEqual([]);
		expect(set.add("c")).toEqual(["a"]);
	});

	it("setMaxEntries() shrinks immediately and reports what it dropped", () => {
		const set = new BoundedSet<string>(4);
		set.add("a");
		set.add("b");
		set.add("c");
		expect(set.setMaxEntries(8)).toEqual([]);
		expect(set.getMaxEntries()).toBe(8);
		expect(set.size).toBe(3);
		expect(set.setMaxEntries(1)).toEqual(["a", "b"]);
		expect(set.getMaxEntries()).toBe(1);
		expect([...set]).toEqual(["c"]);
	});

	it("has/add/delete/clear/size/iteration behave as a bounded Set", () => {
		const set = new BoundedSet<string>(5);
		set.add("a");
		set.add("b");
		expect(set.size).toBe(2);
		expect(set.has("a")).toBe(true);
		expect([...set]).toEqual(["a", "b"]);
		expect([...set.values()]).toEqual(["a", "b"]);
		expect(set.delete("a")).toBe(true);
		expect(set.has("a")).toBe(false);
		expect(set.size).toBe(1);
		set.clear();
		expect(set.size).toBe(0);
	});
});
