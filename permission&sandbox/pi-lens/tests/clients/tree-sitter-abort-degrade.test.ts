import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { moduleReport } from "../../clients/module-report.js";
import { buildOrUpdateGraph } from "../../clients/review-graph/builder.js";
import {
	_resetSharedTreeSitterClientForTests,
	markTreeSitterWasmAborted,
} from "../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";

/**
 * After an unrecoverable Emscripten abort() the shared TreeSitterClient is
 * poisoned process-wide (#402 seam). Every consumer that moved onto the shared
 * client must DEGRADE — return an empty/annotated result — never throw. These
 * exercise the `if (!client) return <empty>` guards added to the migrated sites,
 * which the happy-path suite (healthy client) never reaches.
 *
 * Isolated in its own file so the module-level poison can't leak into other
 * test files' tree-sitter usage; reset after each test regardless.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	_resetSharedTreeSitterClientForTests(); // un-poison the singleton
	resetDegradationLedger();
});

describe("tree-sitter wasm-abort degradation (shared client)", () => {
	it("records the process-poisoning WASM abort once", () => {
		const client = new TreeSitterClient();
		client.reportWasmAbort(new Error("Aborted(native code called abort())"));
		client.reportWasmAbort(new Error("Aborted(second symptom)"));
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "wasm-abort",
				count: 1,
				latestReasons: [
					{
						subject: "web-tree-sitter",
						reason: "Aborted(native code called abort())",
					},
				],
			}),
		]);
	});
	it("module_report returns an unavailable report instead of throwing", async () => {
		const env = setupTestEnvironment("pi-lens-tsabort-mr-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "m.ts", "export const x = 1;\n");

		markTreeSitterWasmAborted();

		const report = await moduleReport(file, env.tmpDir);
		expect(report.available).toBe(false);
		expect(report.error ?? "").toMatch(/aborted|unavailable/i);
		expect(report.api).toEqual([]);
	});

	it("review-graph build completes (empty symbols) instead of throwing", async () => {
		const env = setupTestEnvironment("pi-lens-tsabort-rg-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "a.ts", "export function f() {}\n");

		markTreeSitterWasmAborted();

		// Poisoned parser ⇒ extractTreeSitterSymbols returns empty; the build must
		// still resolve without throwing.
		await expect(
			buildOrUpdateGraph(env.tmpDir, [file], new FactStore()),
		).resolves.toBeDefined();
	});
});
