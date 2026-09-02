import { describe, expect, it } from "vitest";
import {
	biomeRuleNameFromCategory,
	normalizeBiomeSeverity,
	parseBiomeJson as parseBiomeJsonImpl,
} from "../../../../clients/dispatch/runners/biome-check.js";

/****************************************************************
 * NOTE: This test file tests the Biome JSON parser logic.
 *
 * The actual biome-check runner spawns the biome CLI binary,
 * which isn't available in tests. Instead, we test the JSON
 * parsing logic directly with mock Biome JSON output, importing
 * the REAL `parseBiomeJson`/`normalizeBiomeSeverity` from the
 * compiled runner rather than an inlined copy (#1791) — a private
 * copy here would silently drift from the shipped mapping.
 *
 * To run integration tests with the actual biome binary,
 * use the doctor command or manual testing.
 ****************************************************************/

describe("biome-check JSON parser", () => {
	function parseBiomeJson(raw: string, filePath: string) {
		return parseBiomeJsonImpl(raw, filePath).diagnostics;
	}

	describe("parseBiomeJson", () => {
		it("parses error diagnostics correctly", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "noShadow",
						message: "Do not shadow variables",
						location: {
							path: "test.ts",
							start: { line: 10, column: 5 },
							end: { line: 10, column: 8 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(1);
			// #1791: toMatchObject, not toEqual — the real parser also carries
			// fixable/autoFixAvailable/fixKind (driven by getAutofixCapability),
			// which the old test's private inlined copy never produced.
			expect(result[0]).toMatchObject({
				id: "biome:noShadow:10",
				message: "Do not shadow variables",
				filePath: "/src/test.ts",
				line: 10,
				column: 5,
				severity: "error",
				semantic: "blocking",
				tool: "biome",
				rule: "noShadow",
			});
		});

		it("parses warning diagnostics as non-blocking", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "warning",
						category: "preferOptionalChain",
						message: "Use optional chaining instead",
						location: {
							path: "test.ts",
							start: { line: 5, column: 10 },
							end: { line: 5, column: 20 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(1);
			expect(result[0].severity).toBe("warning");
			expect(result[0].semantic).toBe("warning");
		});

		it("handles multiple diagnostics", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "noUnusedVariables",
						message: "Unused variable",
						location: {
							path: "test.ts",
							start: { line: 1, column: 1 },
							end: { line: 1, column: 5 },
						},
					},
					{
						severity: "warning",
						category: "noConsole",
						message: "Do not use console",
						location: {
							path: "test.ts",
							start: { line: 2, column: 1 },
							end: { line: 2, column: 8 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(2);
			expect(result[0].severity).toBe("error");
			expect(result[1].severity).toBe("warning");
		});

		it("handles empty diagnostics array", () => {
			const biomeOutput = JSON.stringify({ diagnostics: [] });
			const result = parseBiomeJson(biomeOutput, "/src/test.ts");
			expect(result).toHaveLength(0);
		});

		it("handles missing diagnostics field", () => {
			const biomeOutput = JSON.stringify({});
			const result = parseBiomeJson(biomeOutput, "/src/test.ts");
			expect(result).toHaveLength(0);
		});

		it("handles invalid JSON gracefully", () => {
			const result = parseBiomeJson("not valid json", "/src/test.ts");
			expect(result).toHaveLength(0);
		});

		it("maps all severity levels correctly", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "e1",
						message: "Error",
						location: {
							path: "f",
							start: { line: 1, column: 1 },
							end: { line: 1, column: 1 },
						},
					},
					{
						severity: "warning",
						category: "w1",
						message: "Warning",
						location: {
							path: "f",
							start: { line: 2, column: 1 },
							end: { line: 2, column: 1 },
						},
					},
					{
						// #1810 review F3: real `biome lint --reporter=json` (2.5.7,
						// live-probed across all 514 shipped lint rules) spells this
						// tier "info", never "information" — the value this fixture
						// used to assert, which meant the parser's own "information"
						// branch was never actually reachable and every real info-tier
						// finding silently fell to the `default: "warning"` branch.
						severity: "info",
						category: "i1",
						message: "Info",
						location: {
							path: "f",
							start: { line: 3, column: 1 },
							end: { line: 3, column: 1 },
						},
					},
					{
						// "hint" is NOT a real `biome lint` severity value: probing
						// every one of the 514 shipped 2.5.7 lint rules' `explain`
						// output found only error/warn/info as a configurable or
						// default severity — the config schema's own
						// `RulePlainConfiguration` enum is `off|on|info|warn|error`,
						// with no `hint` member. This case is a defensive
						// pass-through for a value the real `lint` command has never
						// been observed to emit, not a confirmed-real fixture.
						severity: "hint",
						category: "h1",
						message: "Hint",
						location: {
							path: "f",
							start: { line: 4, column: 1 },
							end: { line: 4, column: 1 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(4);
			expect(result[0].severity).toBe("error");
			expect(result[0].semantic).toBe("blocking");
			expect(result[1].severity).toBe("warning");
			expect(result[1].semantic).toBe("warning");
			// #1791/#1810: biome's real "info" tier survives as Diagnostic
			// severity "info", instead of being collapsed into "warning".
			expect(result[2].severity).toBe("info");
			expect(result[2].semantic).toBe("warning");
			// "hint" survives as-is (defensive pass-through); only "error" is a
			// blocking semantic.
			expect(result[3].severity).toBe("hint");
			expect(result[3].semantic).toBe("warning");
		});

		it("keeps blocking classification error-only when info/hint tiers are present", () => {
			// #1791/#1810: reviving hint/info severity must not widen what blocks.
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "info",
						category: "i1",
						message: "Info",
						location: {
							path: "f",
							start: { line: 1, column: 1 },
							end: { line: 1, column: 1 },
						},
					},
					{
						severity: "hint",
						category: "h1",
						message: "Hint",
						location: {
							path: "f",
							start: { line: 2, column: 1 },
							end: { line: 2, column: 1 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result.every((d) => d.semantic !== "blocking")).toBe(true);
		});

		it("uses correct id format", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "noHardcodedCredentials",
						message: "Hardcoded credentials",
						location: {
							path: "config.ts",
							start: { line: 42, column: 15 },
							end: { line: 42, column: 30 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/project/config.ts");

			expect(result[0].id).toBe("biome:noHardcodedCredentials:42");
		});
	});

	describe("biomeRuleNameFromCategory", () => {
		it("extracts the bare rule name from a lint category", () => {
			expect(biomeRuleNameFromCategory("lint/style/useConst")).toBe("useConst");
			expect(
				biomeRuleNameFromCategory("lint/suspicious/noDuplicateObjectKeys"),
			).toBe("noDuplicateObjectKeys");
		});

		it("returns undefined for a non-lint category", () => {
			// e.g. `assist/source/organizeImports` from `biome check` (never
			// produced by the `lint` command this runner invokes) or an
			// internal pseudo-category.
			expect(
				biomeRuleNameFromCategory("assist/source/organizeImports"),
			).toBeUndefined();
			expect(biomeRuleNameFromCategory(undefined)).toBeUndefined();
			expect(biomeRuleNameFromCategory("")).toBeUndefined();
		});
	});

	describe("parseBiomeJson fixability (#1810)", () => {
		// Real `biome lint --reporter=json` output, captured 2026-08-20 against
		// the shipped @biomejs/biome 2.5.7 binary (satisfies package.json's
		// ^2.4.10) via `node_modules/.bin/biome lint --reporter=json
		// --config-path=config/biome/core.jsonc`. Confirms the real shape: no
		// `tags` field, and `location.path` (not `location.source`).
		const REAL_USE_CONST_OUTPUT = JSON.stringify({
			summary: {
				changed: 0,
				unchanged: 1,
				matches: 0,
				errors: 1,
				warnings: 0,
				infos: 0,
			},
			diagnostics: [
				{
					severity: "error",
					message: "This let declares a variable that is only assigned once.",
					category: "lint/style/useConst",
					location: {
						path: "src/example.ts",
						start: { line: 1, column: 1 },
						end: { line: 1, column: 4 },
					},
					advices: [
						{
							start: { line: 1, column: 5 },
							end: { line: 1, column: 6 },
							text: "Safe fix: Use const instead.",
						},
					],
				},
			],
			command: "lint",
		});

		it("carries no `tags` field on a real diagnostic and never crashes reading location.path", () => {
			const parsed = JSON.parse(REAL_USE_CONST_OUTPUT);
			expect(parsed.diagnostics[0].tags).toBeUndefined();
			expect(parsed.diagnostics[0].location.source).toBeUndefined();
			expect(parsed.diagnostics[0].location.path).toBe("src/example.ts");

			const result = parseBiomeJsonImpl(
				REAL_USE_CONST_OUTPUT,
				"/project/src/example.ts",
			);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].line).toBe(1);
			expect(result.diagnostics[0].column).toBe(1);
		});

		it("marks a diagnostic fixable when its rule resolves to a safe fix", () => {
			const fixKindByRule = new Map([["useConst", "safe" as const]]);
			const result = parseBiomeJsonImpl(
				REAL_USE_CONST_OUTPUT,
				"/project/src/example.ts",
				fixKindByRule,
			);

			expect(result.diagnostics[0].fixable).toBe(true);
			expect(result.diagnostics[0].autoFixAvailable).toBe(true);
			expect(result.diagnostics[0].fixKind).toBe("pipeline");
		});

		it("marks fixable but NOT auto-fixable when the rule's fix is unsafe", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						message: "Template literals are preferred.",
						category: "lint/style/useTemplate",
						location: {
							path: "src/example.ts",
							start: { line: 2, column: 11 },
							end: { line: 2, column: 18 },
						},
					},
				],
			});
			const fixKindByRule = new Map([["useTemplate", "unsafe" as const]]);
			const result = parseBiomeJsonImpl(
				biomeOutput,
				"/project/src/example.ts",
				fixKindByRule,
			);

			expect(result.diagnostics[0].fixable).toBe(true);
			// The pipeline's own biomeClient.fixFileAsync never passes --unsafe
			// (clients/biome-client.ts), so an unsafe fix must never be offered
			// as something the post-write pipeline will silently apply.
			expect(result.diagnostics[0].autoFixAvailable).toBe(false);
			expect(result.diagnostics[0].fixKind).toBe("pipeline");
		});

		it("stays not-fixable when the rule genuinely has no fix", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						message: "This condition always evaluates to the same value.",
						category: "lint/correctness/noConstantCondition",
						location: {
							path: "src/example.ts",
							start: { line: 5, column: 5 },
							end: { line: 5, column: 9 },
						},
					},
				],
			});
			const fixKindByRule = new Map([["noConstantCondition", "none" as const]]);
			const result = parseBiomeJsonImpl(
				biomeOutput,
				"/project/src/example.ts",
				fixKindByRule,
			);

			expect(result.diagnostics[0].fixable).toBe(false);
			expect(result.diagnostics[0].autoFixAvailable).toBe(false);
			expect(result.diagnostics[0].fixKind).toBeUndefined();
		});

		it("stays not-fixable (never crashes) when no fixKind map is supplied at all", () => {
			// Mutation-proofing: deleting the fixKindByRule wiring must not make
			// every diagnostic silently "fixable" — it must fall back to the old
			// permanently-false baseline, not the opposite failure mode.
			const result = parseBiomeJsonImpl(
				REAL_USE_CONST_OUTPUT,
				"/project/src/example.ts",
			);
			expect(result.diagnostics[0].fixable).toBe(false);
			expect(result.diagnostics[0].autoFixAvailable).toBe(false);
		});
	});

	describe("normalizeBiomeSeverity", () => {
		it("maps each of biome's four declared tiers independently", () => {
			// #1791: each branch asserted independently so deleting/merging any
			// one of them into the "warning" fallback reds this test.
			// #1810 review F3: "info" is the real value (see the live-binary
			// fixture below) — "information" is never emitted and was a
			// hand-written guess the switch matched against nothing real.
			expect(normalizeBiomeSeverity("error")).toBe("error");
			expect(normalizeBiomeSeverity("warning")).toBe("warning");
			expect(normalizeBiomeSeverity("info")).toBe("info");
			expect(normalizeBiomeSeverity("hint")).toBe("hint");
		});

		it("falls back to warning for an unrecognized value", () => {
			expect(normalizeBiomeSeverity(undefined as unknown as "warning")).toBe(
				"warning",
			);
		});

		it("no longer recognizes the never-real 'information' spelling (#1810 F3)", () => {
			// Mutation-proofing: if the "info" case regresses back to
			// "information", this assertion is the one that reds — it pins the
			// exact pre-fix defect (a real "info" diagnostic silently promoted
			// to "warning") as a still-failing case for the wrong spelling.
			expect(normalizeBiomeSeverity("information" as unknown as "info")).toBe(
				"warning",
			);
		});
	});

	describe("real biome 2.5.7 severity tiers (#1810 review F3)", () => {
		// Captured live via `node_modules/.bin/biome lint --reporter=json
		// --no-errors-on-unmatched` (no project config, so biome's own default
		// severities apply) against a fixture with one violation per tier:
		// `debugger;` (noDebugger, error), `let x = 1;` unused-once (useConst,
		// warning), and `"a" + b` string concatenation (useTemplate, info).
		// Every severity value below is the literal value biome printed — none
		// hand-typed.
		const REAL_TIERED_OUTPUT = JSON.stringify({
			summary: {
				changed: 0,
				unchanged: 1,
				matches: 0,
				errors: 1,
				warnings: 1,
				infos: 1,
			},
			diagnostics: [
				{
					severity: "info",
					message: "Template literals are preferred over string concatenation.",
					category: "lint/style/useTemplate",
					location: {
						path: ".probe-biome/tiers.ts",
						start: { line: 5, column: 11 },
						end: { line: 5, column: 18 },
					},
					advices: [],
				},
				{
					severity: "warning",
					message: "This let declares a variable that is only assigned once.",
					category: "lint/style/useConst",
					location: {
						path: ".probe-biome/tiers.ts",
						start: { line: 2, column: 1 },
						end: { line: 2, column: 4 },
					},
					advices: [
						{
							start: { line: 2, column: 5 },
							end: { line: 2, column: 6 },
							text: "Safe fix: Use const instead.",
						},
					],
				},
				{
					severity: "error",
					message: "This is an unexpected use of the debugger statement.",
					category: "lint/suspicious/noDebugger",
					location: {
						path: ".probe-biome/tiers.ts",
						start: { line: 1, column: 1 },
						end: { line: 1, column: 10 },
					},
					advices: [],
				},
			],
			command: "lint",
		});

		it("maps the real info tier to Diagnostic severity 'info', not 'warning'", () => {
			const result = parseBiomeJsonImpl(
				REAL_TIERED_OUTPUT,
				"/project/.probe-biome/tiers.ts",
			);
			expect(result.diagnostics).toHaveLength(3);
			const useTemplateDiag = result.diagnostics.find(
				(d) => d.rule === "lint/style/useTemplate",
			);
			expect(useTemplateDiag?.severity).toBe("info");
			expect(useTemplateDiag?.semantic).toBe("warning");

			const useConstDiag = result.diagnostics.find(
				(d) => d.rule === "lint/style/useConst",
			);
			expect(useConstDiag?.severity).toBe("warning");

			const noDebuggerDiag = result.diagnostics.find(
				(d) => d.rule === "lint/suspicious/noDebugger",
			);
			expect(noDebuggerDiag?.severity).toBe("error");
			expect(noDebuggerDiag?.semantic).toBe("blocking");
		});
	});
});
