import { describe, expect, it } from "vitest";
import { BoundedLruCache } from "../../clients/bounded-cache.js";

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
});
