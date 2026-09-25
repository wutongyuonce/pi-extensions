/**
 * #2420 (remainder of #2414): the model-facing analyze counts must not fold
 * `hint`/`info`-tier findings into `warnings`. The dispatch warnings bucket
 * (`semantic:"warning"|"none"`) still carries hint/info-severity findings that
 * the runner's severity→semantic map folded in; `summarizeWarningTiers` splits
 * them out through the ONE shared severity-projection policy
 * (`classifyDiagnosticTier`), so the analyze surface reports real warnings and
 * advisories separately.
 *
 * Pre-fix (dispatch semantic axis alone, no tier split) this whole file goes
 * red: the symbol does not exist, and the counts fold every non-error tier into
 * warnings.
 */
import { describe, expect, it } from "vitest";

import { summarizeWarningTiers } from "../../../clients/mcp/analyze.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";

/** A warnings-bucket entry: `semantic` is "warning"/"none" (never "blocking"),
 * carrying whatever the rule declared as severity — exactly the shape the
 * dispatcher hands to the count-assembly seam. */
function bucketEntry(severity: Diagnostic["severity"], id: string): Diagnostic {
	return {
		id,
		message: `finding ${id}`,
		filePath: "/x/app.ts",
		line: 1,
		severity,
		// The bug is precisely that hint/info land here as `semantic:"warning"`.
		semantic: "warning",
		tool: "ast-grep-napi",
	};
}

describe("summarizeWarningTiers (#2420)", () => {
	it("counts a hint-only bucket as 0 warnings + N advisories", () => {
		const bucket = [
			bucketEntry("hint", "a"),
			bucketEntry("hint", "b"),
			bucketEntry("info", "c"),
		];
		expect(summarizeWarningTiers(bucket)).toEqual({
			warnings: 0,
			advisories: 3,
		});
	});

	it("keeps the exact real-warning count on a mixed bucket", () => {
		const bucket = [
			bucketEntry("warning", "w1"),
			bucketEntry("warning", "w2"),
			bucketEntry("hint", "h1"),
			bucketEntry("info", "i1"),
		];
		// Real warnings stay put; only the two style opinions move to advisories.
		expect(summarizeWarningTiers(bucket)).toEqual({
			warnings: 2,
			advisories: 2,
		});
	});

	it("never reclassifies error-tier entries as advisories (inversion guard)", () => {
		// An error-severity finding routed into the warnings bucket (rare, but the
		// bucket accepts `semantic:"none"`) must NOT be demoted to an advisory —
		// only hint/info are advisory. It stays counted as a non-advisory.
		const bucket = [bucketEntry("error", "e1"), bucketEntry("hint", "h1")];
		expect(summarizeWarningTiers(bucket)).toEqual({
			warnings: 1,
			advisories: 1,
		});
	});

	it("returns zeroes for an empty bucket", () => {
		expect(summarizeWarningTiers([])).toEqual({ warnings: 0, advisories: 0 });
	});
});
