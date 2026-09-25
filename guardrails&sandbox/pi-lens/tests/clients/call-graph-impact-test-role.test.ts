import { describe, expect, it } from "vitest";
import type { ImpactResult } from "../../clients/call-graph.js";
import { callGraphImpactToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/call-graph-impact.js";

// #1080: the call-graph impact adapter is a producer boundary for the persisted
// project-diagnostics delta (later shown by lens_diagnostics). A caller symbol
// key that resolves to a KNOWN test file must not be persisted as collateral
// call-graph impact; a normal caller must remain.

const cwd = "/repo";

function willBreak(symbolKey: string): ImpactResult {
	return { symbolKey, depth: 1, severity: "WillBreak" };
}

describe("callGraphImpactToProjectDiagnostics — test-role callers (#1080)", () => {
	it("excludes a test-file caller and retains a normal caller", () => {
		const diagnostics = callGraphImpactToProjectDiagnostics(cwd, [
			{
				calleeKey: "/repo/src/foo.ts:doThing",
				results: [
					willBreak("/repo/src/bar.ts:callerFn"),
					willBreak("/repo/src/bar.test.ts:testCaller"),
				],
			},
		]);

		const files = diagnostics.map((d) => d.filePath);
		expect(files).toContain("/repo/src/bar.ts");
		expect(files).not.toContain("/repo/src/bar.test.ts");
		expect(diagnostics).toHaveLength(1);
	});

	it("excludes callers located under a tests/ directory", () => {
		const diagnostics = callGraphImpactToProjectDiagnostics(cwd, [
			{
				calleeKey: "/repo/src/foo.ts:doThing",
				results: [
					willBreak("/repo/src/user.ts:consumer"),
					willBreak("/repo/tests/user-flow.ts:flowCaller"),
				],
			},
		]);

		const files = diagnostics.map((d) => d.filePath);
		expect(files).toEqual(["/repo/src/user.ts"]);
	});

	it("keeps normal callers untouched when no test caller is present", () => {
		const diagnostics = callGraphImpactToProjectDiagnostics(cwd, [
			{
				calleeKey: "/repo/src/foo.ts:doThing",
				results: [willBreak("/repo/src/bar.ts:callerFn")],
			},
		]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.filePath).toBe("/repo/src/bar.ts");
	});
});
