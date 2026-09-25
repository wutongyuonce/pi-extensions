import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../../../../clients/dispatch/types.js";
import {
	linesFor,
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

async function diagnosticsOn(
	code: string,
	sampleFile = "sample.ts",
): Promise<Diagnostic[]> {
	const { ctx } = env.addFile(sampleFile, code);
	return (await astGrepNapiRunner.run(ctx)).diagnostics;
}

describe("ast-grep Sonar gap rules (integration via real runner)", () => {
	it("detects simple Sonar gaps without flagging their safe forms", async () => {
		const diagnostics = await diagnosticsOn(
			[
				"const sorted = arr.sort();",
				"const copied = list.toSorted();",
				"const safeSort = arr.sort((a, b) => a - b);",
				"const octal = 0123;",
				"const hex = 0x1f; const decimal = 100; const float = 0.5; const modernOctal = 0o17;",
				"export let first = 0;",
				"export var second = 0;",
				"export const stable = 0;",
				"",
			].join("\n"),
		);

		expect(linesFor(diagnostics, "no-sort-without-comparator")).toEqual([1, 2]);
		expect(linesFor(diagnostics, "no-octal-literal")).toEqual([4]);
		expect(linesFor(diagnostics, "no-mutable-export")).toEqual([6, 7]);
	});

	it("keeps no-constant-condition scoped to actual constant conditions", async () => {
		const diagnostics = await diagnosticsOn(
			[
				"if (true) { a(); }",
				"if (false) { b(); }",
				"const constant = false ? a : b;",
				"if (cond) { c(); }",
				"while (true) { loop(); }",
				"const dynamic = cond ? a : b;",
				'import { foo } from "./bar.js";',
				"export const value = foo;",
				"",
			].join("\n"),
		);

		expect(linesFor(diagnostics, "no-constant-condition")).toEqual([1, 2, 3]);
	});

	it("runs relational and stopBy rules through the native engine", async () => {
		const diagnostics = await diagnosticsOn(
			[
				"for (const key in object) { use(key); }",
				"for (const value of values) { use(value); }",
				"function five(a: string, b: string, c: string, d: string, e: string) {}",
				"function four(a: string, b: string, c: string, d: string) {}",
				"switch (value) { case 1: a(); break; }",
				"switch (other) { case 1: a(); break; default: b(); }",
				"if (object.hasOwnProperty(key)) {}",
				"function choose() { if (cond) { return 1; } else { return 2; } }",
				"function computeValue() { const result = compute(); return result; }",
				"",
			].join("\n"),
		);

		expect(linesFor(diagnostics, "ts-in-operator-loop")).toEqual([1]);
		expect(linesFor(diagnostics, "long-parameter-list")).toEqual([3]);
		expect(linesFor(diagnostics, "switch-without-default")).toEqual([5]);
		expect(linesFor(diagnostics, "ts-object-hasown-check")).toEqual([7]);
		expect(linesFor(diagnostics, "ts-unnecessary-else-return")).toEqual([8]);
		expect(linesFor(diagnostics, "redundant-state")).toEqual([9]);
	});

	it("matches nested TypeScript ternaries without self-match or JS cross-fire", async () => {
		const diagnostics = await diagnosticsOn(
			[
				"const chained = a ? b : c ? d : e;",
				"const parenthesized = a ? (b ? c : d) : e;",
				"const single = a ? b : c;",
				"",
			].join("\n"),
			"sample.ts",
		);

		expect(linesFor(diagnostics, "nested-ternary")).toEqual([1, 2]);
		expect(linesFor(diagnostics, "nested-ternary-js")).toEqual([]);
	});

	it("matches nested JavaScript ternaries without TS cross-fire", async () => {
		const diagnostics = await diagnosticsOn(
			"const chained = a ? b : c ? d : e;\nconst single = a ? b : c;\n",
			"sample.js",
		);

		expect(linesFor(diagnostics, "nested-ternary-js")).toEqual([1]);
		expect(linesFor(diagnostics, "nested-ternary")).toEqual([]);
	});
});
