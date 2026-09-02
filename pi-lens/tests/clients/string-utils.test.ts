import { describe, expect, it } from "vitest";
import { compareOrdinal } from "../../clients/string-utils.js";

describe("compareOrdinal", () => {
	it("orders by code unit, not locale collation", () => {
		// Code-unit order: "B" (0x42) sorts before "a" (0x61). A locale-aware
		// comparator commonly reverses this (case-insensitive alphabetic
		// collation puts "a" first), which is exactly the divergence this
		// comparator exists to avoid for identity-feeding sorts (#2155, #2165).
		expect(["a", "B"].sort(compareOrdinal)).toEqual(["B", "a"]);
	});

	it("is a stable, symmetric total order", () => {
		expect(compareOrdinal("a", "a")).toBe(0);
		expect(compareOrdinal("a", "b")).toBeLessThan(0);
		expect(compareOrdinal("b", "a")).toBeGreaterThan(0);
	});

	it("produces the same key regardless of input insertion order", () => {
		const left = ["zeta", "Alpha", "_beta"].sort(compareOrdinal).join(",");
		const right = ["_beta", "zeta", "Alpha"].sort(compareOrdinal).join(",");
		expect(left).toBe(right);
	});
});
