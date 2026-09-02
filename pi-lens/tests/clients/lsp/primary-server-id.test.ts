import { describe, expect, it } from "vitest";
import {
	getServersForFileWithConfig,
	primaryServerId,
} from "../../../clients/lsp/config.js";

/**
 * #646: `primaryServerId` was extracted out of `tools/lsp-diagnostics.ts`
 * into `clients/lsp/config.ts` so `tools/lens-diagnostics.ts`'s mode=full
 * sweep can share the exact same primary-vs-auxiliary classification instead
 * of hand-copying it. This guards the extraction: the shared helper must
 * behave IDENTICALLY to the old inline `lsp-diagnostics.ts` version (`
 * getServersForFileWithConfig(filePath).find((s) => s.role !== "auxiliary")
 * ?.id`) for every case that matters — a plain language-server file, a file
 * served only by auxiliary scanners, and a file with no matching server at
 * all — so `lsp_diagnostics` sees no behavior change from the move.
 */
function oldInlinePrimaryServerId(filePath: string): string | undefined {
	return getServersForFileWithConfig(filePath).find(
		(s) => s.role !== "auxiliary",
	)?.id;
}

describe("primaryServerId (clients/lsp/config.ts)", () => {
	it("returns the real language server id for a plain source file, matching the old inline implementation", () => {
		const filePath = "/proj/src/index.ts";
		expect(primaryServerId(filePath)).toBe("typescript");
		expect(primaryServerId(filePath)).toBe(oldInlinePrimaryServerId(filePath));
	});

	it("returns marksman as the primary for markdown (#274), matching the old inline implementation", () => {
		const filePath = "/proj/README.md";
		expect(primaryServerId(filePath)).toBe("marksman");
		expect(primaryServerId(filePath)).toBe(oldInlinePrimaryServerId(filePath));
	});

	it("returns undefined for a file with no matching server, matching the old inline implementation", () => {
		const filePath = "/proj/data.unknownext12345";
		expect(primaryServerId(filePath)).toBeUndefined();
		expect(primaryServerId(filePath)).toBe(oldInlinePrimaryServerId(filePath));
	});

	it("never returns an auxiliary server id even when an auxiliary scanner is the only match for an extension", () => {
		// Every server returned by getServersForFileWithConfig for a real source
		// file includes both primary and auxiliary entries (ast-grep/opengrep/
		// zizmor/typos attach to broad extension sets) — primaryServerId must
		// skip role:"auxiliary" entries entirely, regardless of registry order.
		const filePath = "/proj/src/index.ts";
		const servers = getServersForFileWithConfig(filePath);
		expect(servers.some((s) => s.role === "auxiliary")).toBe(true);
		const id = primaryServerId(filePath);
		expect(servers.find((s) => s.id === id)?.role).not.toBe("auxiliary");
	});
});
