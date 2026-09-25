/**
 * #3088, failure-semantics row "filter throws → passthrough + one bounded
 * degradation record" (AGENTS.md shape 48: name the concrete harm and pick the
 * fallback direction from it). The `source=lsp` probe lane is the security
 * lane's read surface; a finding that stays VISIBLE because the filter broke is
 * recoverable, one silently hidden by a broken filter is not. The throw is
 * injected at a module boundary (`clients/dispatch/rule-policy.js`) because no
 * reachable input makes the real stack throw — every collaborator inside it is
 * itself fail-open, which is exactly why an unexpected throw is the case worth
 * pinning.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../clients/dispatch/rule-policy.js", async (importOriginal) => ({
	...(await importOriginal()),
	applyRulePolicy: () => {
		throw new Error("policy exploded");
	},
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { clearWidgetState } from "../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const MESSAGE = "Type 'string' is not assignable to type 'number'.";

let cwd: string;
let filePath: string;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3088-failopen-"));
	filePath = path.join(cwd, "app.ts");
	fs.writeFileSync(filePath, "const value: number = 'bad';\n");
	resetDegradationLedger();
	clearWidgetState();
});

afterEach(() => {
	resetDegradationLedger();
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("source=lsp finding policy fails open (#3088)", () => {
	it("still reports the finding, and records one bounded degradation, when the filter throws", async () => {
		const service = {
			touchFile: vi.fn(async () => ({
				diags: [
					{
						severity: 2,
						message: MESSAGE,
						source: "typescript",
						code: 2322,
						serverId: "typescript",
						range: {
							start: { line: 0, character: 6 },
							end: { line: 0, character: 11 },
						},
					},
				],
			})),
			getDiagnostics: vi.fn(async () => []),
			getCapabilitySnapshots: vi.fn(async () => []),
		};
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => cwd,
			() => service as never,
		);

		const result = (await tool.execute(
			"diag-failopen",
			{ source: "lsp", scope: "paths", paths: [filePath] },
			new AbortController().signal,
			null,
			{ cwd },
		)) as { isError?: boolean; content: Array<{ text: string }> };

		expect(result.isError).toBe(false);
		expect(result.content[0].text).toContain(MESSAGE);
		const kinds = getDegradationSummary().map((entry) => entry.kind);
		expect(kinds.filter((kind) => kind === "lsp-probe-finding-policy")).toEqual(
			["lsp-probe-finding-policy"],
		);
	});
});
