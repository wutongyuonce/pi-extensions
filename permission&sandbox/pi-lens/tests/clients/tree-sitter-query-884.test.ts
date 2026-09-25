/**
 * Issue #884: repaired java/cpp/css/php rules must compile against their real
 * grammars and distinguish representative buggy code from correct code.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
} from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	_resetSharedTreeSitterClientForTests();
});

const cases = [
	[
		"infinite-loop-java",
		"java",
		"java",
		"class C { void f() { while (true) {} for (;;) {} } }",
		"class C { void f(boolean b) { while (b) {} } }",
	],
	[
		"no-double-checked-locking",
		"java",
		"java",
		"class C { void f() { if (x == null) { synchronized (x) { if (x == null) {} } } } }",
		"class C { void f() { if (x == null) { synchronized (x) { work(); } } } }",
	],
	[
		"no-field-shadowing",
		"java",
		"java",
		"class Parent { protected int value; } class Child extends Parent { int value; }",
		"class Parent { protected int value; } class Child extends Parent { int childValue; }",
	],
	[
		"switch-fall-through",
		"java",
		"java",
		"class C { void f(int x) { switch (x) { case 1: work(); case 2: break; } } }",
		"class C { void f(int x) { switch (x) { case 1: work(); break; } } }",
	],
	[
		"switch-non-case-labels",
		"java",
		"java",
		"class C { void f(int x) { switch (x) { case 1: label: work(); } } }",
		"class C { void f(int x) { switch (x) { case 1: work(); } } }",
	],
	[
		"no-scoped-lock-without-args",
		"cpp",
		"cpp",
		"void f() { std::scoped_lock lock; }",
		"void f(std::mutex& m) { std::scoped_lock lock(m); }",
	],
	[
		"calc-spacing",
		"css",
		"css",
		"a { width: calc(100%-20px); }",
		"a { width: calc(100% - 20px); }",
	],
	[
		"this-in-static-context",
		"php",
		"php",
		"<?php class C { public static function f() { return $this->x; } }",
		"<?php class C { public function f() { return $this->x; } }",
	],
] as const;

const EXT: Record<string, string> = {
	java: "java",
	cpp: "cpp",
	css: "css",
	php: "php",
};

describe("issue #884 tree-sitter queries (java/cpp/css/php)", () => {
	for (const [id, language, _kind, positive, negative] of cases) {
		it(`${id} compiles and distinguishes representative code`, async () => {
			const env = setupTestEnvironment(`pi-lens-884-${id}-`);
			cleanups.push(env.cleanup);
			const client = getSharedTreeSitterClient();
			expect(client).not.toBeNull();
			expect(await client!.init()).toBe(true);

			const loader = new TreeSitterQueryLoader();
			const loaded = await loader.loadQueries(process.cwd());
			const rule = loaded.get(language)?.find((q) => q.id === id);
			expect(rule, `rule ${language}/${id} must exist`).toBeTruthy();

			const posFile = createTempFile(
				env.tmpDir,
				`pos.${EXT[language]}`,
				positive,
			);
			const negFile = createTempFile(
				env.tmpDir,
				`neg.${EXT[language]}`,
				negative,
			);

			const posMatches = await client!.runQueryOnFile(rule!, posFile, language);
			const negMatches = await client!.runQueryOnFile(rule!, negFile, language);

			expect(
				posMatches.length,
				`${id} should flag the buggy snippet`,
			).toBeGreaterThan(0);
			expect(negMatches.length, `${id} should leave correct code alone`).toBe(
				0,
			);
		});
	}
});
