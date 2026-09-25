import { describe, expect, it } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";
import type { AstGrepDiagnostic } from "../../clients/ast-grep-types.js";

/**
 * #1791: `formatDiagnostics` is the on-demand ast-grep CLI path's rendering
 * seam (`clients/ast-grep-client.ts:811-813`). It bucketed error/warning/hint
 * but had no `info` bucket, so an info-tier finding was counted in the total
 * header but never named in any tier line — the same "declared tier, silently
 * dropped from a tally" defect shape #1787 fixed for the napi path.
 */
function diag(overrides: Partial<AstGrepDiagnostic>): AstGrepDiagnostic {
	return {
		line: 1,
		column: 1,
		endLine: 1,
		endColumn: 5,
		severity: "warning",
		message: "example finding",
		rule: "example-rule",
		file: "example.ts",
		...overrides,
	};
}

describe("AstGrepClient.formatDiagnostics — severity tier rendering", () => {
	it("names the info tier alongside error/warning/hint", () => {
		const client = new AstGrepClient();
		const output = client.formatDiagnostics([
			diag({ severity: "error", rule: "e1" }),
			diag({ severity: "warning", rule: "w1" }),
			diag({ severity: "info", rule: "i1" }),
			diag({ severity: "hint", rule: "h1" }),
		]);

		expect(output).toContain("1 error(s)");
		expect(output).toContain("1 warning(s)");
		expect(output).toContain("1 info(s)");
		expect(output).toContain("1 hint(s)");
	});

	it("counts every info-tier finding, not just the first", () => {
		const client = new AstGrepClient();
		const output = client.formatDiagnostics([
			diag({ severity: "info", rule: "i1" }),
			diag({ severity: "info", rule: "i2" }),
			diag({ severity: "info", rule: "i3" }),
		]);

		expect(output).toContain("3 info(s)");
	});

	it("omits the info line entirely when no info findings are present", () => {
		const client = new AstGrepClient();
		const output = client.formatDiagnostics([
			diag({ severity: "warning", rule: "w1" }),
		]);

		expect(output).not.toContain("info(s)");
	});
});
