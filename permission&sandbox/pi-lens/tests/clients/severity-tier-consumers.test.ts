// #1777 class sweep: the ast-grep dispatch runner used to collapse
// warning/hint/info to "warning", which shielded every downstream consumer of
// `Diagnostic.severity` from the hint and info tiers. This suite pins the
// behavior of the three consumers that now see them for the first time:
//
//   1. `clients/code-quality-warnings.ts` — the per-tier report and advisory.
//   2. `clients/actionable-warnings.ts`   — a hint-tier rule with a fix.
//   3. `clients/widget-state.ts`          — the TUI blocking/errors/warnings tally.

import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { recordFromDispatchDiagnostic } from "../../clients/actionable-warnings.js";
import {
	buildCodeQualityWarningsReport,
	formatCodeQualityWarningsAdvisory,
	recordFromCodeQualityDiagnostic,
} from "../../clients/code-quality-warnings.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	clearWidgetState,
	getFileDiagnosticSummaries,
	recordDiagnostics,
} from "../../clients/widget-state.js";

const cwd = path.join("tmp", "sev1777");
const filePath = path.resolve(cwd, "src", "a.ts");

function makeDiagnostic(
	severity: Diagnostic["severity"],
	extra: Partial<Diagnostic> = {},
): Diagnostic {
	return {
		id: `sev-${severity}`,
		message: `${severity}-tier finding`,
		filePath,
		line: 10,
		column: 1,
		severity,
		semantic: severity === "error" ? "blocking" : "warning",
		tool: "ast-grep-napi",
		rule: `rule-${severity}`,
		...extra,
	};
}

describe("code-quality warnings render the hint and info tiers distinctly (#1777)", () => {
	it("keeps each tier on its record instead of flattening to warning", () => {
		for (const severity of ["warning", "info", "hint"] as const) {
			expect(
				recordFromCodeQualityDiagnostic(makeDiagnostic(severity), cwd)
					?.severity,
			).toBe(severity);
		}
	});

	it("counts the tiers separately in the report summary", () => {
		const warnings = (["warning", "hint", "hint", "info"] as const).map(
			(severity, index) =>
				recordFromCodeQualityDiagnostic(
					makeDiagnostic(severity, {
						line: 10 + index,
						message: `${severity} finding ${index}`,
					}),
					cwd,
				),
		);
		const report = buildCodeQualityWarningsReport({
			cwd,
			sessionId: "s1",
			turnIndex: 1,
			warnings: warnings.map((warning) => warning!),
			modifiedRangesByFile: new Map(),
		});
		expect(report.summary.byTier).toEqual({ warning: 1, info: 1, hint: 2 });
		expect(report.summary.warnings).toBe(4);
	});

	it("names the quieter tiers in the advisory", () => {
		const warnings = (["warning", "hint"] as const).map((severity, index) =>
			recordFromCodeQualityDiagnostic(
				makeDiagnostic(severity, {
					line: 20 + index,
					message: `${severity} finding ${index}`,
				}),
				cwd,
			),
		);
		const report = buildCodeQualityWarningsReport({
			cwd,
			sessionId: "s1",
			turnIndex: 1,
			warnings: warnings.map((warning) => warning!),
			modifiedRangesByFile: new Map(),
		});
		const advisory = formatCodeQualityWarningsAdvisory(report, cwd) ?? "";
		expect(advisory).toContain("1 warning");
		expect(advisory).toContain("1 hint");
	});

	// The tier exists so hints do not dominate the stream. The report cap is the
	// one place volume is actually rationed, so warnings must win the budget.
	it("spends the report budget on warnings before hints", () => {
		const records = [
			...Array.from({ length: 3 }, (_, index) =>
				recordFromCodeQualityDiagnostic(
					makeDiagnostic("hint", {
						// Sorted first by displayPath, so under a naive slice these
						// hints would consume the whole budget.
						filePath: path.resolve(cwd, "src", "aaa.ts"),
						line: index + 1,
						message: `hint ${index}`,
					}),
					cwd,
				),
			),
			recordFromCodeQualityDiagnostic(
				makeDiagnostic("warning", {
					filePath: path.resolve(cwd, "src", "zzz.ts"),
					line: 1,
					message: "real warning",
				}),
				cwd,
			),
		].map((record) => record!);

		const report = buildCodeQualityWarningsReport({
			cwd,
			sessionId: "s1",
			turnIndex: 1,
			warnings: records,
			modifiedRangesByFile: new Map(),
			maxWarnings: 2,
		});
		const kept = report.files.flatMap((file) => file.warnings);
		expect(kept).toHaveLength(2);
		expect(kept.filter((w) => w.severity === "warning")).toHaveLength(1);
		expect(kept.filter((w) => w.severity === "hint")).toHaveLength(1);
	});

	// The budget is spent tier by tier, so the kept set must be re-sorted into
	// display order before it is grouped into files. Otherwise a file renders
	// its warnings first and its hints after, out of line order.
	it("still renders line order within the kept set, across tiers", () => {
		const records = (
			[
				[3, "warning"],
				[1, "hint"],
				[2, "hint"],
			] as const
		).map(([line, severity]) =>
			recordFromCodeQualityDiagnostic(
				makeDiagnostic(severity, { line, message: `${severity} ${line}` }),
				cwd,
			)!,
		);
		const report = buildCodeQualityWarningsReport({
			cwd,
			sessionId: "s1",
			turnIndex: 1,
			warnings: records,
			modifiedRangesByFile: new Map(),
		});
		expect(report.files[0]?.warnings.map((w) => w.line)).toEqual([1, 2, 3]);
	});
});

// Both reports are persisted to `.pi-lens/cache/` and read back by
// `tools/lens-diagnostics.ts` and `clients/runtime-agent-end.ts`, which can find
// a file written by a build that predates `byTier`. Neither advisory may crash
// on it.
describe("tier-aware advisories tolerate a pre-#1777 cached report", () => {
	it("formats a code-quality report whose summary has no byTier", () => {
		const report = buildCodeQualityWarningsReport({
			cwd,
			sessionId: "s1",
			turnIndex: 1,
			warnings: [
				recordFromCodeQualityDiagnostic(makeDiagnostic("warning"), cwd)!,
			],
			modifiedRangesByFile: new Map(),
		});
		const legacy = {
			...report,
			summary: { ...report.summary, byTier: undefined },
		};
		expect(formatCodeQualityWarningsAdvisory(legacy, cwd)).toContain(
			"Code-quality warnings introduced/touched this turn: 1",
		);
	});
});

describe("actionable warnings accept a fix from any non-error tier (#1777)", () => {
	it("records a hint-tier rule that carries a fix suggestion", () => {
		const record = recordFromDispatchDiagnostic(
			makeDiagnostic("hint", { fixSuggestion: "replace with a narrow check" }),
			cwd,
		);
		expect(record).toBeDefined();
		expect(record?.severity).toBe("hint");
	});

	it("records an info-tier rule that carries a fix suggestion", () => {
		expect(
			recordFromDispatchDiagnostic(
				makeDiagnostic("info", { fixable: true }),
				cwd,
			)?.severity,
		).toBe("info");
	});

	it("still ignores a tier with no fix at all", () => {
		expect(
			recordFromDispatchDiagnostic(makeDiagnostic("hint"), cwd),
		).toBeUndefined();
	});

	it("still ignores blocking and error-severity diagnostics", () => {
		expect(
			recordFromDispatchDiagnostic(
				makeDiagnostic("error", { fixable: true }),
				cwd,
			),
		).toBeUndefined();
		expect(
			recordFromDispatchDiagnostic(
				makeDiagnostic("error", { semantic: "warning", fixable: true }),
				cwd,
			),
		).toBeUndefined();
	});
});

// #1777 made hint/info survive the dispatch path (previously collapsed to
// "warning" at the runner) and, at the time, folded them into the widget's
// `warnings` tally so they weren't dropped from the footer entirely. #2414
// found that fold itself was the defect: a hint-tier style opinion (e.g.
// `no-runtime-typeof`, a complexity hint) presented with the same `!NW`
// warning-icon weight as a real, bounded-false-positive-rate warning. The
// tally now keeps hint/info VISIBLE (via `advisories`, not dropped) without
// inflating `warnings`.
describe("widget tally separates the advisory tier from warnings (#1777 -> #2414)", () => {
	beforeEach(() => clearWidgetState());

	it("counts hint and info as advisories, not warnings", () => {
		recordDiagnostics(filePath, [
			{ severity: "hint", semantic: "warning", message: "hint finding" },
			{ severity: "info", semantic: "warning", message: "info finding" },
			{ severity: "warning", semantic: "warning", message: "warning finding" },
		]);
		const summary = getFileDiagnosticSummaries()[0];
		expect(summary).toMatchObject({
			blocking: 0,
			errors: 0,
			warnings: 1,
			advisories: 2,
		});
	});

	it("still counts errors separately, and a lone hint stays out of warnings", () => {
		recordDiagnostics(filePath, [
			{ severity: "error", semantic: "blocking", message: "boom" },
			{ severity: "hint", semantic: "warning", message: "hint finding" },
		]);
		expect(getFileDiagnosticSummaries()[0]).toMatchObject({
			blocking: 1,
			errors: 1,
			warnings: 0,
			advisories: 1,
		});
	});
});
