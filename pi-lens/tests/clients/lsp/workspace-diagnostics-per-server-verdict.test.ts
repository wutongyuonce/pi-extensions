import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient: vi.fn(),
}));

describe("#1549 workspace sweep per-server verdict", () => {
	let root: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-sweep-verdict-"));
	});

	afterEach(() => removeTempDirSync(root));

	it("keeps a fast primary finding when one auxiliary is silent and names only that lane", async () => {
		const filePath = path.join(root, "answer.ts");
		fs.writeFileSync(filePath, "const answer: string = 42;\n");
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "typescript",
				extensions: [".ts"],
				root: async () => root,
			},
		]);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		vi.spyOn(service, "ensureWarmForSweep").mockResolvedValue({
			performedWarmup: false,
			failedServerIds: [],
		});
		vi.spyOn(service, "getClientsForFile").mockResolvedValue({
			clients: [],
			primarySpawnInFlight: false,
		} as never);
		vi.spyOn(service, "touchFile").mockResolvedValue({
			diags: [
				{
					severity: 1,
					message: "Type 'number' is not assignable to type 'string'.",
					source: "typescript",
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 12 },
					},
				},
			],
			confirmation: "partial",
			unconfirmedServerIds: ["typos"],
		} as never);

		const [result] = await service.runWorkspaceDiagnostics(root, {
			files: [filePath],
		});

		expect(result.diagnostics.map((diag) => diag.message)).toEqual([
			"Type 'number' is not assignable to type 'string'.",
		]);
		expect(result.timedOut).toBeUndefined();
		expect(result.unconfirmedServerIds).toEqual(["typos"]);
	});
});
