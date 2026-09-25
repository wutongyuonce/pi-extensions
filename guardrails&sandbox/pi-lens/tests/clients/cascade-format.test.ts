import { describe, expect, it } from "vitest";
import { formatCascadeNeighborDiagnostics } from "../../clients/cascade-format.js";

describe("formatCascadeNeighborDiagnostics", () => {
	it("renders an explicit marker for an inconclusive empty neighbor (#1444)", () => {
		const output = formatCascadeNeighborDiagnostics("C:/repo", [
			{
				filePath: "C:/repo/src/neighbor.ts",
				reason: "imports",
				diagnostics: [],
				lspTouched: true,
				inconclusive: true,
			},
		]);

		expect(output).toContain("neighbor.ts");
		expect(output).toContain("inconclusive");
		expect(output).toContain("no clean result was confirmed");
	});

	it("keeps a confirmed clean neighbor silent", () => {
		expect(
			formatCascadeNeighborDiagnostics("C:/repo", [
				{
					filePath: "C:/repo/src/neighbor.ts",
					reason: "imports",
					diagnostics: [],
					lspTouched: true,
				},
			]),
		).toBe("");
	});
});
