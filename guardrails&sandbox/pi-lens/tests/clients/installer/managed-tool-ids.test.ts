import { describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

const MANAGED_LSP_TOOL_IDS = [
	"pyright",
	"jedi-language-server",
	"deno",
	"rust-analyzer",
	"intelephense",
	"bash-language-server",
	"dockerfile-language-server-nodejs",
	"yaml-language-server",
	"vscode-json-language-server",
	"vscode-html-languageserver-bin",
	"@prisma/language-server",
	"@vue/language-server",
	"svelte-language-server",
	"vscode-css-languageserver",
] as const;

describe("installer managed tool coverage", () => {
	it("has installer definitions for all managed LSP tool IDs", async () => {
		const { isKnownToolId } =
			await import("../../../clients/installer/index.js");
		const missing = MANAGED_LSP_TOOL_IDS.filter(
			(toolId) => !isKnownToolId(toolId),
		);
		expect(missing).toEqual([]);
	});

	it("pins the managed classic TypeScript compiler below TypeScript 7", async () => {
		const { TOOLS } = await import("../../../clients/installer/index.js");
		const typescript = TOOLS.find((tool) => tool.id === "typescript");
		expect(typescript?.packageName).toBe("typescript@5.9.3");
	});
});
