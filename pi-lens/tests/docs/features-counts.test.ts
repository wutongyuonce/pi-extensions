/**
 * docs/features.md quotes two registry sizes. Both had silently drifted by the
 * time #1520 touched them: the doc claimed 42 language servers against 44, and
 * 32 formatters against 33, so adding CUE made each wrong by one more. A prose
 * number that mirrors a registry is the hand-maintained-list defect shape —
 * derive the check instead of re-counting by hand every time.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_FORMATTERS } from "../../clients/formatters.js";
import { LSP_SERVERS } from "../../clients/lsp/server.js";

const featuresMd = readFileSync(
	path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../docs/features.md",
	),
	"utf8",
);

/** The single number in a `**<n> ...**` claim, or undefined if the claim moved. */
function claimedCount(pattern: RegExp): number | undefined {
	const match = pattern.exec(featuresMd);
	return match ? Number(match[1]) : undefined;
}

describe("docs/features.md counts match the registries", () => {
	it("quotes the real language-server count", () => {
		expect(claimedCount(/\*\*(\d+) language server definitions\*\*/)).toBe(
			LSP_SERVERS.length,
		);
	});

	it("quotes the real formatter count", () => {
		expect(claimedCount(/\*\*(\d+) formatters\*\*/)).toBe(
			ALL_FORMATTERS.length,
		);
	});
});
