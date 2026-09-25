import * as fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { RunnerResult } from "../../clients/dispatch/types.js";
import { isTestFile } from "../../clients/file-utils.js";
import {
	firedRuleIds,
	makeRealRunnerCtx,
	makeRealRunnerEnv,
} from "./real-runner-ctx.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const c of cleanups) c();
});

describe("makeRealRunnerEnv", () => {
	it("writes fixtures under one shared cwd with typed ctxs", () => {
		const env = makeRealRunnerEnv();
		cleanups.push(env.cleanup);

		const a = env.addFile("app.py", "x = 1\n");
		const b = env.addFile("tests/test_app.py", "y = 2\n");

		expect(fs.readFileSync(a.filePath, "utf8")).toBe("x = 1\n");
		expect(a.ctx.cwd).toBe(env.cwd);
		expect(b.ctx.cwd).toBe(env.cwd);
		expect(a.filePath.startsWith(env.cwd)).toBe(true);
	});

	it("derives kind from the fixture extension, overrides win", () => {
		const env = makeRealRunnerEnv();
		cleanups.push(env.cleanup);

		expect(env.addFile("a.py", "").ctx.kind).toBe("python");
		expect(env.addFile("a.ts", "").ctx.kind).toBe("jsts");

		expect(env.addFile("a.yml", "").ctx.kind).toBe("yaml");

		const forced = makeRealRunnerEnv({ kind: "go" });
		cleanups.push(forced.cleanup);
		expect(forced.addFile("a.py", "").ctx.kind).toBe("go");
		expect(forced.addFile("b.py", "", { kind: "rust" }).ctx.kind).toBe("rust");
		expect(() => env.addFile("unknown.fixture", "")).toThrow(
			/Cannot derive a FileKind/,
		);
	});

	it("temp cwd contains no isTestFile marker (would invert skip_test_files assertions)", () => {
		const env = makeRealRunnerEnv();
		cleanups.push(env.cleanup);
		expect(isTestFile(env.addFile("app.py", "").filePath)).toBe(false);
		expect(isTestFile(env.addFile("tests/test_app.py", "").filePath)).toBe(
			true,
		);
	});

	it("cleanup removes the temp dir", () => {
		const env = makeRealRunnerEnv();
		env.addFile("a.ts", "");
		env.cleanup();
		expect(fs.existsSync(env.cwd)).toBe(false);
	});
});

describe("makeRealRunnerCtx", () => {
	it("is a one-fixture wrapper over makeRealRunnerEnv", () => {
		const real = makeRealRunnerCtx("src/app.py", "x = 1\n", {
			blockingOnly: true,
		});
		cleanups.push(real.cleanup);

		expect(fs.existsSync(real.filePath)).toBe(true);
		expect(real.ctx.cwd).toBe(real.cwd);
		expect(real.ctx.kind).toBe("python");
		expect(real.ctx.blockingOnly).toBe(true);
	});
});

describe("firedRuleIds", () => {
	it("projects d.rule only, skipping diagnostics without one", () => {
		const result = {
			status: "succeeded",
			semantic: "warning",
			diagnostics: [
				{ id: "tree-sitter:a:1", rule: "rule-a" },
				{ id: "tree-sitter:a:5", rule: "rule-a" },
				{ id: "no-rule" },
			],
		} as unknown as RunnerResult;
		expect(firedRuleIds(result)).toEqual(new Set(["rule-a"]));
	});
});
