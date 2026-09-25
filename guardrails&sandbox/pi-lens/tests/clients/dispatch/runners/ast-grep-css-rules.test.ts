/**
 * CSS-language ast-grep rules through the napi in-process fallback (#2199).
 *
 * These tests use a real runner invocation. They verify both that CSS rules
 * run on CSS roots and that they do not run on HTML roots.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	dispatchForFile,
	RunnerRegistry,
} from "../../../../clients/dispatch/dispatcher.js";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import {
	firedRuleIds,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
});
afterAll(() => env.cleanup());

describe("ast-grep CSS rules (integration via napi fallback)", () => {
	it("dispatches CSS files to napi and reports a real rule finding", async () => {
		const { ctx } = env.addFile(
			"dispatch.css",
			[".modal {", "  z-index: 9999 !important;", "}", ""].join("\n"),
		);
		const registry = new RunnerRegistry();
		registry.register(astGrepNapiRunner);
		expect(ctx.kind).toBe("css");
		const selected = registry.getForKind("css", ctx.filePath);
		const result = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: selected.map((runner) => runner.id) }],
			registry,
		);

		expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).toContain(
			"no-important",
		);
	});

	it("fires no-important on a real !important declaration", async () => {
		const { ctx } = env.addFile(
			"sample.css",
			[".modal {", "  z-index: 9999 !important;", "}", ""].join("\n"),
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(firedRuleIds(result)).toContain("no-important");
	});

	it("does not fire on plain CSS without !important", async () => {
		const { ctx } = env.addFile(
			"plain.css",
			[".button {", "  color: red;", "}", ""].join("\n"),
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(firedRuleIds(result)).not.toContain("no-important");
	});

	it("does not run a CSS rule on an HTML root", async () => {
		env.addFile(
			"rules/ast-grep-rules/rules/html-element-local.yml",
			[
				"id: html-element-local",
				"language: Css",
				"message: HTML elements must not match CSS rules",
				"severity: warning",
				"rule:",
				"  kind: element",
				"",
			].join("\n"),
		);
		const { ctx } = env.addFile(
			"sample.html",
			["<!doctype html>", "<p>content</p>", ""].join("\n"),
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(firedRuleIds(result)).not.toContain("html-element-local");
	});
});
