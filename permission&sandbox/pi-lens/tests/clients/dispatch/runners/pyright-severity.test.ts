import { describe, expect, it } from "vitest";
import {
	normalizePyrightSeverity,
	parsePyrightOutput,
} from "../../../../clients/dispatch/runners/pyright.js";

/**
 * #1802: pyright's `--outputjson` output declares three severities on
 * `generalDiagnostics[].severity` — "error", "warning", "information" — but
 * the runner collapsed "information" into "warning", the same defect shape
 * #1787 fixed for ast-grep-napi and #1791 fixed for biome-check. These tests
 * import the REAL `parsePyrightOutput`/`normalizePyrightSeverity` from the
 * compiled runner (not an inlined copy) so the mapping can't drift silently
 * out of sync with what's shipped.
 *
 * #1802 fix round: the original fixture used an invented `{ start: { line,
 * column } }` shape pyright never emits. The real shape (pyright's own
 * docs, docs/command-line.md "JSON Output") is
 * `{ file, severity, message, rule?, range: { start: { line, character },
 * end } }` — no top-level `start`, and `range` positions are zero-based.
 * `range` is omitted entirely when pyright has nothing to point at. Fixed
 * both the fixture shape and the parser (which previously read a `start`
 * field that real pyright output never has, so every real diagnostic
 * landed at line 0/column 0).
 */
describe("normalizePyrightSeverity", () => {
	it("maps information to info", () => {
		expect(normalizePyrightSeverity("information")).toBe("info");
	});

	it("passes error and warning through unchanged", () => {
		expect(normalizePyrightSeverity("error")).toBe("error");
		expect(normalizePyrightSeverity("warning")).toBe("warning");
	});

	it("falls back to warning for an unrecognized value", () => {
		expect(normalizePyrightSeverity(undefined)).toBe("warning");
		expect(normalizePyrightSeverity("bogus" as never)).toBe("warning");
	});
});

describe("parsePyrightOutput", () => {
	// Documented pyright --outputjson shape: no top-level `start`, and
	// `range.start`/`range.end` positions are zero-based.
	function makeData(severity: string) {
		return {
			generalDiagnostics: [
				{
					severity,
					message: "example diagnostic",
					file: "/proj/example.py",
					rule: "reportExample",
					range: {
						start: { line: 2, character: 4 },
						end: { line: 2, character: 10 },
					},
				},
			],
		};
	}

	it("preserves pyright's information tier as info, not warning", () => {
		const diags = parsePyrightOutput(
			makeData("information"),
			"/proj/example.py",
		);
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("info");
		// Non-error severities stay non-blocking.
		expect(diags[0].semantic).toBe("warning");
	});

	it("keeps error diagnostics blocking", () => {
		const diags = parsePyrightOutput(makeData("error"), "/proj/example.py");
		expect(diags[0].severity).toBe("error");
		expect(diags[0].semantic).toBe("blocking");
	});

	it("keeps warning diagnostics as warning/non-blocking", () => {
		const diags = parsePyrightOutput(makeData("warning"), "/proj/example.py");
		expect(diags[0].severity).toBe("warning");
		expect(diags[0].semantic).toBe("warning");
	});

	it("never widens blocking classification for the info tier", () => {
		const diags = parsePyrightOutput(
			makeData("information"),
			"/proj/example.py",
		);
		// Mutation guard: an info-tier diagnostic must stay non-blocking even
		// though its severity display tier changed.
		expect(diags[0].semantic).not.toBe("blocking");
	});

	it("converts range.start's zero-based line/character to one-based line/column", () => {
		// #1802 fix round: on pre-fix code every real diagnostic landed at
		// line 0/column 0, because the parser read a top-level `start` field
		// real pyright output never sets. line 2 (0-based) / character 4
		// (0-based) must become line 3 / column 5.
		const diags = parsePyrightOutput(makeData("warning"), "/proj/example.py");
		expect(diags[0].line).toBe(3);
		expect(diags[0].column).toBe(5);
	});

	it("falls back to line 1/column 1 when range is omitted", () => {
		// pyright omits `range` entirely when it has no location to report.
		const data = {
			generalDiagnostics: [
				{
					severity: "error",
					message: "no location",
					file: "/proj/example.py",
					rule: "reportExample",
				},
			],
		};
		const diags = parsePyrightOutput(data, "/proj/example.py");
		expect(diags[0].line).toBe(1);
		expect(diags[0].column).toBe(1);
	});
});
