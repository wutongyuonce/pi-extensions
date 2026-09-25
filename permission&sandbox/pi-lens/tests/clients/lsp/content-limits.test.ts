/**
 * #3405 round 2: both branches of the ONE bound on document content pi-lens
 * hands a language server.
 *
 * Recurrence this file prevents: the byte and line bounds used to be duplicated
 * (a private function in `clients/pipeline.ts`, an inline copy in
 * `clients/dispatch/runners/lsp.ts`) and neither copy had a test of its own —
 * so folding them into one module would have left the shared predicate's two
 * branches mutation-inert, with every consumer's coverage coming from fixtures
 * that happened to trip whichever branch first. Review finding M3406-1 is the
 * cost of that: a third writer was added with no bound at all.
 */

import { describe, expect, it } from "vitest";
import { exceedsLspSyncLimits } from "../../../clients/lsp/content-limits.js";
import { RUNTIME_CONFIG } from "../../../clients/runtime-config.js";

const MAX_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const MAX_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;

describe("exceedsLspSyncLimits (#3405 r2)", () => {
	it("refuses a document past the byte bound, on few lines", () => {
		// The minified-bundle shape: the LINE bound is nowhere near tripped, so
		// this case can only fail on bytes.
		const verdict = exceedsLspSyncLimits(`${"x".repeat(MAX_BYTES + 1)}\n`);
		expect(verdict.tooLarge).toBe(true);
		expect(verdict.reason).toContain("bytes >");
	});

	it("refuses a document past the line bound, well inside the byte bound", () => {
		// The inverse shape: ~2 bytes per line keeps the byte total tiny, so this
		// case can only fail on lines.
		const verdict = exceedsLspSyncLimits("a\n".repeat(MAX_LINES + 1));
		expect(verdict.tooLarge).toBe(true);
		expect(verdict.reason).toContain("lines >");
	});

	it("admits a document inside both bounds", () => {
		const verdict = exceedsLspSyncLimits("const x = 1;\n".repeat(10));
		expect(verdict).toEqual({ tooLarge: false, reason: "" });
	});

	it("admits a document exactly at each bound", () => {
		// Both comparisons are strict `>`, so the boundary value itself is in
		// bounds — a `>=` slip would refuse files the repository has always synced.
		expect(exceedsLspSyncLimits("x".repeat(MAX_BYTES)).tooLarge).toBe(false);
		expect(exceedsLspSyncLimits("a\n".repeat(MAX_LINES - 1)).tooLarge).toBe(
			false,
		);
	});
});
