import { describe, expect, it } from "vitest";
import {
	normalizeClippyLevel,
	parseClippyOutput,
} from "../../../../clients/dispatch/runners/rust-clippy.js";

/**
 * #1802 fix round: the PR originally claimed rustc/clippy's top-level
 * `compiler-message.level` is genuinely two-valued (error/warning) and left
 * the mapping unchanged. A live `cargo clippy --message-format=json` repro
 * falsified that claim during review — rustc_errors's `Level` serializes six
 * values, and top-level messages with a real primary span are not limited
 * to error/warning. These tests reproduce the review's repro shapes against
 * the REAL `normalizeClippyLevel`/`parseClippyOutput` (not an inlined copy).
 */
function clippyMessage(
	level: string,
	message: string,
	spans: Array<{
		file?: string;
		line_start?: number;
		column_start?: number;
	}>,
	code?: string,
): string {
	return JSON.stringify({
		reason: "compiler-message",
		message: {
			code: code ? { code } : undefined,
			message,
			level,
			spans,
		},
	});
}

describe("normalizeClippyLevel", () => {
	it("maps error to error", () => {
		expect(normalizeClippyLevel("error")).toBe("error");
	});

	it("maps warning to warning", () => {
		expect(normalizeClippyLevel("warning")).toBe("warning");
	});

	it("maps a top-level note to hint (previously collapsed to warning)", () => {
		expect(normalizeClippyLevel("note")).toBe("hint");
	});

	it("maps a top-level help to info", () => {
		expect(normalizeClippyLevel("help")).toBe("info");
	});

	it("maps an internal compiler error to error, never under-reporting", () => {
		expect(normalizeClippyLevel("error: internal compiler error")).toBe(
			"error",
		);
	});

	it("falls back to warning for an unrecognized value", () => {
		expect(normalizeClippyLevel(undefined)).toBe("warning");
		expect(normalizeClippyLevel("bogus")).toBe("warning");
	});
});

describe("parseClippyOutput — six-level severity (#1802 fix round)", () => {
	it("reports a top-level note with a primary span as hint, not warning", () => {
		// Reviewer's repro shape: an erroneous-constant note pointing at the
		// offending expression, carrying its own primary span.
		const raw = clippyMessage(
			"note",
			"erroneous constant used",
			[{ file: "src/main.rs", line_start: 4, column_start: 2 }],
			"erroneous_constant",
		);
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("hint");
		expect(diags[0].semantic).toBe("warning");
	});

	it("reports a top-level help with a primary span as info", () => {
		const raw = clippyMessage(
			"help",
			"consider using `?` operator",
			[{ file: "src/main.rs", line_start: 8, column_start: 1 }],
			"question_mark",
		);
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("info");
		expect(diags[0].semantic).toBe("warning");
	});

	it("classifies an internal compiler error as blocking, not warning", () => {
		const raw = clippyMessage(
			"error: internal compiler error",
			"ICE while type-checking",
			[{ file: "src/main.rs", line_start: 1, column_start: 1 }],
		);
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("error");
		expect(diags[0].semantic).toBe("blocking");
	});

	it("skips a failure-note carrying no spans (verified, not just filtered by luck)", () => {
		const raw = JSON.stringify({
			reason: "compiler-message",
			message: {
				message: "failed to write output",
				level: "failure-note",
				spans: [],
			},
		});
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(0);
	});

	it("still reports plain error/warning diagnostics unchanged", () => {
		const raw = [
			clippyMessage(
				"error",
				"mismatched types",
				[{ file: "src/main.rs", line_start: 2, column_start: 1 }],
				"mismatched_types",
			),
			clippyMessage(
				"warning",
				"unused variable",
				[{ file: "src/main.rs", line_start: 6, column_start: 5 }],
				"unused_variables",
			),
		].join("\n");
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(2);
		expect(diags[0].severity).toBe("error");
		expect(diags[0].semantic).toBe("blocking");
		expect(diags[1].severity).toBe("warning");
		expect(diags[1].semantic).toBe("warning");
	});
});
