/**
 * #884 — tree-sitter rules whose queries never compiled (silently dead since
 * authoring). Each rule below had a query that failed to compile against the
 * real grammar (wrong node/field names, an invalid inline regex flag, or an
 * unimplemented post_filter). These tests pin the repaired rules end-to-end:
 * every one must match a minimal snippet embodying the bug it hunts and leave a
 * nearby correct snippet alone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-884-"));
	tmpDirs.push(dir);
	const filePath = path.join(dir, `sample.${ext}`);
	fs.writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

async function getQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	for (const langQueries of queries.values()) {
		const found = langQueries.find((q) => q.id === id);
		if (found) return found;
	}
	throw new Error(`missing query ${id}`);
}

async function count(id: string, ext: string, lang: string, src: string) {
	const client = getSharedTreeSitterClient()!;
	const query = await getQuery(id);
	const file = writeTempFile(ext, src);
	return (await client.runQueryOnFile(query, file, lang)).length;
}

afterAll(() => {
	for (const dir of tmpDirs) removeTempDirSync(dir);
});

describe("empty-switch-case (TS)", () => {
	it("matches a case with no body and no following label", async () => {
		expect(
			await count(
				"empty-switch-case",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  doWork();\n  break;\n case 2:\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match cases that all have bodies", async () => {
		expect(
			await count(
				"empty-switch-case",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  doWork();\n  break;\n case 2:\n  other();\n  break;\n}`,
			),
		).toBe(0);
	});

	it("does not match grouped labels sharing the next case's body", async () => {
		// `case "a": case "b": handle()` is idiomatic fall-through grouping, not a
		// dead case — flagging it made every grouped switch a blocking error.
		expect(
			await count(
				"empty-switch-case",
				"ts",
				"typescript",
				`switch (x) {\n case "a":\n case "b":\n  handle();\n  break;\n}`,
			),
		).toBe(0);
	});

	it("does not match a label grouped onto a following default", async () => {
		expect(
			await count(
				"empty-switch-case",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  handle();\n  break;\n case 2:\n default:\n  other();\n}`,
			),
		).toBe(0);
	});
});

describe("infinite-loop (TS)", () => {
	it("matches while(true) with no exit", async () => {
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`while (true) {\n doWork();\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("matches for(;;) with no exit", async () => {
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`for (;;) {\n tick();\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match while(true) that breaks", async () => {
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`while (true) {\n if (done) break;\n doWork();\n}`,
			),
		).toBe(0);
	});

	it("does not match while(true) exited by a labeled break from a nested loop", async () => {
		// A plain `break` inside a nested loop is swallowed by it, but `break outer;`
		// leaves the labeled loop — the loop is not infinite.
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`outer: while (true) {\n for (const a of b) {\n  if (a) break outer;\n }\n}`,
			),
		).toBe(0);
	});

	it("does not match for(;;) that returns", async () => {
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`for (;;) {\n return 1;\n}`,
			),
		).toBe(0);
	});
});

describe("duplicate-function-arg (TS)", () => {
	it("matches duplicate parameter names", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function add(a, a) { return a; }`,
			),
		).toBeGreaterThan(0);
	});

	it("matches non-adjacent duplicate parameters", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f(a, b, a) { return a + b; }`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match unique parameters", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function add(a, b) { return a + b; }`,
			),
		).toBe(0);
	});

	it("does not match a default value referencing another param's name", async () => {
		// `root = node` is a default value, not a second parameter named `node`.
		// The query must bind only the `pattern` field (the param name), never an
		// identifier nested inside a type annotation or default-value expression.
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f(node: TreeSitterNode, root: TreeSitterNode = node) { return root; }`,
			),
		).toBe(0);
	});

	it("still matches duplicates when a param has a default value", async () => {
		// The `pattern:`-field fix must not silence genuine duplicates elsewhere.
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function g(a, b = a, a) { return a + b; }`,
			),
		).toBeGreaterThan(0);
	});

	it("matches a duplicate rest parameter", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f(a, ...a) { return a; }`,
			),
		).toBeGreaterThan(0);
	});

	it("matches duplicate names in destructured patterns", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f({ a }, [b, a]) { return a + b; }`,
			),
		).toBeGreaterThan(0);
	});

	it("does not treat an annotation reference as a duplicate binding", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f(a: T, b: typeof a) { return b; }`,
			),
		).toBe(0);
	});

	it("covers arrow parameters without treating defaults as bindings", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`const f = (a, ...a) => a;`,
			),
		).toBeGreaterThan(0);
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function outer(a, b = (() => a)) { return b; }`,
			),
		).toBe(0);
	});

	// #1270 follow-up: `bindingNames` walked every descendant `identifier`,
	// so a reference inside a destructuring default or a computed property
	// key was wrongly counted as a bound parameter name. These pin the
	// binding-aware traversal — only `left`/binding positions count, never
	// the default-value expression or a computed key's expression.
	it("does not treat a destructured default's reference as a binding", () => {
		return Promise.all([
			expect(
				count(
					"duplicate-function-arg",
					"ts",
					"typescript",
					`function f({a = b}, b) {}`,
				),
			).resolves.toBe(0),
			expect(
				count(
					"duplicate-function-arg",
					"ts",
					"typescript",
					`function f([a = b], b) {}`,
				),
			).resolves.toBe(0),
			expect(
				count(
					"duplicate-function-arg",
					"ts",
					"typescript",
					`function f({x: a = b}, b) {}`,
				),
			).resolves.toBe(0),
			expect(
				count(
					"duplicate-function-arg",
					"ts",
					"typescript",
					`function f({a = (() => b)}, b) {}`,
				),
			).resolves.toBe(0),
		]);
	});

	it("does not treat a computed property key's reference as a binding", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f({[key]: a}, key) {}`,
			),
		).toBe(0);
	});

	it("still flags a genuine duplicate when one param self-references its own default", async () => {
		// `{a = a}` binds `a` on the left (the right-hand `a` is only a
		// reference, per the cases above); the second param is also named
		// `a`, so this really is `function f(a, a) {}` in disguise — Node
		// itself rejects it with "Duplicate parameter name not allowed in
		// this context". A binding-aware traversal must still flag it.
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f({a = a}, a) {}`,
			),
		).toBeGreaterThan(0);
	});
});

describe("mixed-async-styles (TS)", () => {
	it("matches await mixed with a .then() chain", async () => {
		expect(
			await count(
				"mixed-async-styles",
				"ts",
				"typescript",
				`async function getUser() {\n const r = await fetch("/u");\n return r.json().then((d) => d.name);\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match consistent async/await", async () => {
		expect(
			await count(
				"mixed-async-styles",
				"ts",
				"typescript",
				`async function getUser() {\n const r = await fetch("/u");\n const d = await r.json();\n return d.name;\n}`,
			),
		).toBe(0);
	});
});

describe("switch-case-termination (TS)", () => {
	it("matches a case that falls through", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match cases that terminate", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  return "one";\n case 2:\n  break;\n}`,
			),
		).toBe(0);
	});

	it.each([
		[
			"a block-wrapped terminating case",
			`{ const body = compute(); return body; }`,
			0,
		],
		["a block-wrapped non-terminating case", `{ compute(); }`, 1],
		[
			"nested trailing blocks that terminate",
			`{ compute(); { return "one"; } }`,
			0,
		],
		["an empty trailing block", `{ }`, 1],
		[
			"a try/catch that returns on every path",
			`try { return "one"; } catch (e) { return "two"; }`,
			0,
		],
		[
			"a try/catch whose catch falls through",
			`try { return "one"; } catch (e) { handle(e); }`,
			1,
		],
		[
			"a try/finally whose try returns",
			`try { return "one"; } finally { cleanup(); }`,
			0,
		],
		[
			"a try/finally that falls through",
			`try { work(); } finally { cleanup(); }`,
			1,
		],
		[
			"an exhaustive if/else",
			`if (x) { return "one"; } else { return "two"; }`,
			0,
		],
		["an if without an else", `if (x) { return "one"; }`, 1],
		["an intentional fallthrough comment", `doSomething(); // fallthrough`, 0],
	])("%s", async (_name, caseBody, expected) => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1: ${caseBody}\n case 2:\n  break;\n}`,
			),
		).toBe(expected);
	});

	it("does not match grouped labels sharing one body", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case "a":\n case "b":\n  handle();\n  break;\n}`,
			),
		).toBe(0);
	});

	it("does not treat a 'falls through' comment in a nested function as a marker", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  const g = () => { /* falls through */ };\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not treat a 'falls through' comment in a nested function inside a trailing try/catch as a marker", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  try { const g = () => { /* falls through */ }; work(); } catch (e) { handle(e); }\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not treat a leading comment as a fallthrough marker", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  // fallthrough\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("honors a fallthrough comment inside a trailing block", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  { doSomething(); /* fallthrough */ }\n case 2:\n  break;\n}`,
			),
		).toBe(0);
	});
});

describe("ts-insecure-random (TS)", () => {
	it("matches Math.random() feeding a security-sensitive binding", async () => {
		expect(
			await count(
				"ts-insecure-random",
				"ts",
				"typescript",
				`const token = Math.random().toString(36);`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match Math.random() for a non-sensitive binding", async () => {
		expect(
			await count(
				"ts-insecure-random",
				"ts",
				"typescript",
				`const ratio = Math.random();`,
			),
		).toBe(0);
	});
});

describe("switch-case-termination-js (JS)", () => {
	it("matches a case that falls through", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match cases that terminate", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  return "one";\n case 2:\n  break;\n}`,
			),
		).toBe(0);
	});

	it.each([
		[
			"a block-wrapped terminating case",
			`{ const body = compute(); return body; }`,
			0,
		],
		["a block-wrapped non-terminating case", `{ compute(); }`, 1],
		[
			"nested trailing blocks that terminate",
			`{ compute(); { return "one"; } }`,
			0,
		],
		["an empty trailing block", `{ }`, 1],
		[
			"a try/catch that returns on every path",
			`try { return "one"; } catch (e) { return "two"; }`,
			0,
		],
		[
			"a try/catch whose catch falls through",
			`try { return "one"; } catch (e) { handle(e); }`,
			1,
		],
		[
			"a try/finally whose try returns",
			`try { return "one"; } finally { cleanup(); }`,
			0,
		],
		[
			"a try/finally that falls through",
			`try { work(); } finally { cleanup(); }`,
			1,
		],
		[
			"an exhaustive if/else",
			`if (x) { return "one"; } else { return "two"; }`,
			0,
		],
		["an if without an else", `if (x) { return "one"; }`, 1],
		["an intentional fallthrough comment", `doSomething(); // fallthrough`, 0],
	])("%s", async (_name, caseBody, expected) => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1: ${caseBody}\n case 2:\n  break;\n}`,
			),
		).toBe(expected);
	});

	it("does not match grouped labels sharing one body", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case "a":\n case "b":\n  handle();\n  break;\n}`,
			),
		).toBe(0);
	});

	it("does not treat a 'falls through' comment in a nested function as a marker", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  const g = () => { /* falls through */ };\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not treat a 'falls through' comment in a nested function inside a trailing try/catch as a marker", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  try { const g = () => { /* falls through */ }; work(); } catch (e) { handle(e); }\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not treat a leading comment as a fallthrough marker", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  // fallthrough\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("honors a fallthrough comment inside a trailing block", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  { doSomething(); /* fallthrough */ }\n case 2:\n  break;\n}`,
			),
		).toBe(0);
	});
});

describe("switch-non-case-labels-js (JS)", () => {
	it("matches a non-case label inside a switch", async () => {
		expect(
			await count(
				"switch-non-case-labels-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  break;\n case 2:\n  myLabel:\n   doSomething();\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match a normal switch", async () => {
		expect(
			await count(
				"switch-non-case-labels-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  break;\n default:\n  break;\n}`,
			),
		).toBe(0);
	});
});
