import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DependencyChecker,
	type CircularDep,
} from "../../clients/dependency-checker.js";

describe("DependencyChecker.formatScanResult cycle-key comparator (#2155, #2165 class)", () => {
	it("dedupes the same cycle reported from two anchors by a code-unit key, immune to a comparator that answers inconsistently across calls", () => {
		const checker = new DependencyChecker();
		// The same two-file cycle, reported once per anchor file — the exact
		// "same member set, different anchor" shape `formatScanResult`'s dedupe
		// exists for.
		const circular: CircularDep[] = [
			{ file: "a.ts", path: ["a.ts", "b.ts"] },
			{ file: "b.ts", path: ["b.ts", "a.ts"] },
		];

		const realLocaleCompare = String.prototype.localeCompare;
		let call = 0;
		try {
			// Simulate a locale-dependent comparator that answers the SAME
			// question differently across the two cycles' key computations —
			// exactly what two OS locales (or a locale change mid-session) can
			// do to real `localeCompare`. A comparator this unstable must not
			// affect the dedupe key at all.
			String.prototype.localeCompare = function (this: string, that: string) {
				call++;
				if (this === "a.ts" && that === "b.ts") return call <= 1 ? -1 : 1;
				if (this === "b.ts" && that === "a.ts") return call <= 1 ? 1 : -1;
				return realLocaleCompare.call(this, that);
			};

			const output = checker.formatScanResult(circular);
			const cycleLines = output
				.split("\n")
				.filter((line) => line.includes("→"));
			expect(cycleLines).toHaveLength(1);
		} finally {
			String.prototype.localeCompare = realLocaleCompare;
		}
	});

	it("renders the original discovery path order and does not mutate the shared CircularDep (review F2)", () => {
		const checker = new DependencyChecker();
		// Discovery order is the actual a→b→c→a traversal — meaningful, and
		// distinct from both the localeCompare and the code-unit sort order of
		// these three names. The dedupe key's sort must never leak into what a
		// user reads, and must not mutate `dep.path` in place: other CircularDep
		// consumers (e.g. madge.ts's diagnostic renderer) read the same object.
		const dep: CircularDep = {
			file: "middle.ts",
			path: ["middle.ts", "alpha.ts", "Zeta.ts"],
		};
		const originalPath = [...dep.path];

		const output = checker.formatScanResult([dep]);

		const expectedNames = originalPath
			.map((p) => path.relative(process.cwd(), p))
			.join(" → ");
		expect(output).toContain(`  • ${expectedNames}\n`);
		expect(dep.path).toEqual(originalPath);
	});
});
