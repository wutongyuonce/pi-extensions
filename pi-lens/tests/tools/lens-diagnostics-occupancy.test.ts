/**
 * Scaled event-loop occupancy guard for full-scan content binding.
 *
 * The LSP service normally supplies a `boundToCurrentDisk` verdict after its
 * own content-binding seam. A full scan must trust that verdict instead of
 * re-reading every file synchronously in the result loop. This fixture keeps
 * the result count at the documented 5,000-file scale so a regression to
 * readFileSync is visible as a long event-loop block.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { clearWidgetState } from "../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const FILE_COUNT = 5_000;
// This is a regression guard for the quadratic re-read/rebind class, not a
// tight performance budget. The fixed path is normally ~300-450 ms on CI and
// Windows, while the quadratic regression measured >1,500 ms; leave room for
// host variance without allowing that regression to pass.
const MAX_SYNC_BLOCK_MS = 1_000;
const CONTENT = "const value = 1;\n";

let cwd: string;
let files: string[];

beforeAll(() => {
	cwd = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-full-binding-occupancy-"),
	);
	files = [];
	for (let i = 0; i < FILE_COUNT; i += 1) {
		const file = path.join(cwd, `${i}.ts`);
		fs.writeFileSync(file, CONTENT);
		files.push(file);
	}
	clearWidgetState();
}, 60_000);

afterAll(() => {
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("lens_diagnostics full-scan binding occupancy", () => {
	it(
		"does not synchronously re-read 5,000 already-bound files",
		{ retry: 2, timeout: 30_000 },
		async () => {
			const contentHash = hashDiagnosticContent(CONTENT);
			const lspService = {
				runWorkspaceDiagnostics: vi.fn().mockResolvedValue(
					files.map((filePath) => ({
						filePath,
						diagnostics: [],
						contentHash,
						boundToCurrentDisk: true,
					})),
				),
			};
			const tool = createLensDiagnosticsTool(
				{
					readCache: vi.fn().mockReturnValue(undefined),
				} as any,
				() => cwd,
				() => lspService as any,
			);

			const maxBlock = await measureMaxSyncBlockMs(async () => {
				await tool.execute(
					"1",
					{ mode: "full" },
					new AbortController().signal,
					null,
					{ cwd },
				);
			});

			expect(lspService.runWorkspaceDiagnostics).toHaveBeenCalledOnce();
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);
});
