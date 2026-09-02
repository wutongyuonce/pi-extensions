import { describe, expect, it } from "vitest";
import { isZizmorIgnoreSuppressed } from "../../../clients/dispatch/auxiliary-lsp.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";

// Minimal LSPDiagnostic for the matcher: it only reads range.start.line + code.
function diag(line0Based: number, code?: string): LSPDiagnostic {
	return {
		range: {
			start: { line: line0Based, character: 0 },
			end: { line: line0Based, character: 1 },
		},
		message: "finding",
		severity: 1,
		code,
	} as unknown as LSPDiagnostic;
}

describe("isZizmorIgnoreSuppressed (#971)", () => {
	it("`# zizmor: ignore[artipacked]` suppresses a checkout-only job's finding", () => {
		const content =
			"steps:\n  - uses: actions/checkout@11bd719 # zizmor: ignore[artipacked]\n";
		expect(isZizmorIgnoreSuppressed(diag(1, "artipacked"), content)).toBe(true);
	});

	it("`# zizmor: ignore[adhoc-packages]` suppresses a local-tarball install", () => {
		const content =
			'run: npm install -g "$TARBALL" # zizmor: ignore[adhoc-packages]\n';
		expect(isZizmorIgnoreSuppressed(diag(0, "adhoc-packages"), content)).toBe(
			true,
		);
	});

	it("only suppresses the named audit id, not an unrelated one", () => {
		const content = "run: foo # zizmor: ignore[artipacked]\n";
		expect(isZizmorIgnoreSuppressed(diag(0, "artipacked"), content)).toBe(true);
		expect(isZizmorIgnoreSuppressed(diag(0, "adhoc-packages"), content)).toBe(
			false,
		);
	});

	it("supports comma-separated audit ids", () => {
		const content = "run: foo # zizmor: ignore[artipacked, adhoc-packages]\n";
		expect(isZizmorIgnoreSuppressed(diag(0, "artipacked"), content)).toBe(true);
		expect(isZizmorIgnoreSuppressed(diag(0, "adhoc-packages"), content)).toBe(
			true,
		);
	});

	it("does NOT suppress a finding on an unrelated line", () => {
		const content = "run: foo # zizmor: ignore[artipacked]\nrun: bar\n";
		expect(isZizmorIgnoreSuppressed(diag(1, "artipacked"), content)).toBe(
			false,
		);
	});

	it("is a no-op with no zizmor ignore comment", () => {
		const content = 'run: npm install -g "$TARBALL"\n';
		expect(isZizmorIgnoreSuppressed(diag(0, "adhoc-packages"), content)).toBe(
			false,
		);
	});
});
