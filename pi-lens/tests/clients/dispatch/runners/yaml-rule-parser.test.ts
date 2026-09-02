import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ESM can't redefine an unmocked module's exports (vi.spyOn on a bare `fs`
// import throws "Module namespace is not configurable"). Wrapping `statSync`
// through `vi.mock` — same shape as `nested-ignore-freshness-clock.test.ts`'s
// mock for the sibling cadence — makes it spy-able.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		readdirSync: vi.fn(actual.readdirSync),
		statSync: vi.fn(actual.statSync),
		existsSync: vi.fn(actual.existsSync),
		openSync: vi.fn(actual.openSync),
	};
});

import {
	loadYamlRules,
	loadYamlRulesUncached,
	parseSimpleYaml,
	isOverlyBroadPattern,
	isStructuredRule,
	RULES_CACHE_FRESHNESS_CADENCE_MS,
} from "../../../../clients/dispatch/runners/yaml-rule-parser.js";

const ruleCacheTempDirs: string[] = [];

function writeRule(filePath: string, id: string, message: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		[
			`id: ${id}`,
			"severity: warning",
			`message: ${message}`,
			"rule:",
			"  pattern: $X",
			"",
		].join("\n"),
	);
}

function messages(rules: ReturnType<typeof loadYamlRules>): string[] {
	return rules.map((rule) => rule.message ?? "").sort();
}

const FIXED_DIRECTORY_MTIME = new Date("2000-01-01T00:00:00.000Z");

afterEach(() => {
	vi.useRealTimers();
	for (const dir of ruleCacheTempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * `getCachedRules` now skips its stat sweep entirely inside
 * `RULES_CACHE_FRESHNESS_CADENCE_MS` (round 2 of #2262 — see
 * `yaml-rule-parser.ts`). An edit made and re-read within the same window is
 * invisible until the window elapses, mirroring `file-utils.ts`'s
 * `PROJECT_IGNORE_FRESHNESS_CADENCE_MS` contract. These two cases advance a
 * fake clock past the window before the second read, exactly as
 * `nested-ignore-freshness-clock.test.ts` does for the sibling cadence.
 */
describe("yaml-rule-parser cache freshness (#2262)", () => {
	it("reloads an edited existing rule when the directory mtime is unchanged", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-rules-cache-"));
		ruleCacheTempDirs.push(root);
		const file = path.join(root, "existing.yml");
		writeRule(file, "existing", "old");
		fs.utimesSync(root, FIXED_DIRECTORY_MTIME, FIXED_DIRECTORY_MTIME);
		vi.useFakeTimers();
		const start = Date.now();
		const first = loadYamlRules(root);

		// The replacement message must differ in LENGTH from "old": the metadata
		// tier is mtimeMs+size only, and NTFS mtime granularity makes a same-size
		// rewrite collide with the original stamp ~90% of the time (flaked 3/24
		// on Windows). A size change is what the mechanism actually detects.
		writeRule(file, "existing", "renewed");
		fs.utimesSync(root, FIXED_DIRECTORY_MTIME, FIXED_DIRECTORY_MTIME);
		vi.setSystemTime(start + RULES_CACHE_FRESHNESS_CADENCE_MS + 1);

		expect(messages(loadYamlRules(root))).toEqual(["renewed"]);
		expect(messages(first)).toEqual(["old"]);
	});

	it("discovers a nested rule file when the root directory mtime is unchanged", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pilens-rules-cache-nested-"),
		);
		ruleCacheTempDirs.push(root);
		writeRule(path.join(root, "root.yml"), "root", "root");
		fs.utimesSync(root, FIXED_DIRECTORY_MTIME, FIXED_DIRECTORY_MTIME);
		vi.useFakeTimers();
		const start = Date.now();
		loadYamlRules(root);

		writeRule(path.join(root, "nested", "child.yml"), "child", "child");
		fs.utimesSync(root, FIXED_DIRECTORY_MTIME, FIXED_DIRECTORY_MTIME);
		vi.setSystemTime(start + RULES_CACHE_FRESHNESS_CADENCE_MS + 1);

		expect(messages(loadYamlRules(root))).toEqual(["child", "root"]);
	});

	it("performs one metadata sweep and no content reads per cadence window", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pilens-rules-cache-bounded-"),
		);
		ruleCacheTempDirs.push(root);
		writeRule(path.join(root, "a.yml"), "a", "a");
		writeRule(path.join(root, "nested", "b.yml"), "b", "b");
		writeRule(path.join(root, "nested", "c.yml"), "c", "c");
		writeRule(path.join(root, "nested", "deeper", "d.yml"), "d", "d");
		writeRule(path.join(root, "nested", "deeper", "e.yml"), "e", "e");
		const ruleFileCount = 5;
		vi.useFakeTimers();
		const start = Date.now();
		loadYamlRules(root); // primes the cache: one sweep

		const readFileSpy = vi.mocked(fs.readFileSync);
		const readdirSpy = vi.mocked(fs.readdirSync);
		const statSpy = vi.mocked(fs.statSync);
		const existsSpy = vi.mocked(fs.existsSync);
		const openSpy = vi.mocked(fs.openSync);
		for (const spy of [readFileSpy, readdirSpy, statSpy, existsSpy, openSpy])
			spy.mockClear();
		for (let i = 0; i < 25; i++) loadYamlRules(root);
		expect(readFileSpy).not.toHaveBeenCalled();
		expect(statSpy).not.toHaveBeenCalled();
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(existsSpy).toHaveBeenCalledTimes(25);
		expect(openSpy).not.toHaveBeenCalled();

		vi.setSystemTime(start + RULES_CACHE_FRESHNESS_CADENCE_MS + 1);
		loadYamlRules(root);
		expect(readFileSpy).not.toHaveBeenCalled();
		expect(readdirSpy).toHaveBeenCalledTimes(3);
		expect(statSpy).toHaveBeenCalledTimes(ruleFileCount);
		expect(existsSpy).toHaveBeenCalledTimes(26);
		expect(openSpy).not.toHaveBeenCalled();

		for (let i = 0; i < 25; i++) loadYamlRules(root);
		expect(readFileSpy).not.toHaveBeenCalled();
		expect(readdirSpy).toHaveBeenCalledTimes(3);
		expect(statSpy).toHaveBeenCalledTimes(ruleFileCount);
		expect(existsSpy).toHaveBeenCalledTimes(51);
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("orders discovered rule files by code unit, not by locale collation", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pilens-rules-cache-order-"),
		);
		ruleCacheTempDirs.push(root);
		// Ordinal order puts 'B' (0x42) before 'a' (0x61); default locale
		// collation orders case-insensitively and would put 'a' first. This
		// pins the array order `loadYamlRulesFresh` hashes and `getCachedRules`
		// compares index-by-index (#2262 F4).
		writeRule(path.join(root, "B.yml"), "upper", "upper");
		writeRule(path.join(root, "a.yml"), "lower", "lower");

		const rules = loadYamlRulesUncached(root);
		expect(rules.map((rule) => rule.message)).toEqual(["upper", "lower"]);
	});
});

describe("yaml-rule-parser fix metadata", () => {
	it("parses note and fix fields (including multiline) from ast-grep YAML", () => {
		const yaml = [
			"id: no-global-eval-js",
			"language: JavaScript",
			"severity: error",
			'message: "Avoid eval"',
			"note: |",
			"  Dynamic code execution is dangerous.",
			"  Prefer explicit parsers.",
			'fix: "Replace eval with safe APIs"',
			"rule:",
			"  pattern: eval($CODE)",
		].join("\n");

		const rule = parseSimpleYaml(yaml);
		expect(rule).not.toBeNull();
		expect(rule?.note).toContain("Dynamic code execution is dangerous.");
		expect(rule?.note).toContain("Prefer explicit parsers.");
		expect(rule?.fix).toBe("Replace eval with safe APIs");
	});
});

// #206: the parser is now js-yaml, so the full ast-grep rule grammar survives
// intact and feeds napi directly. The old hand-rolled parser flattened nested
// any/has and dropped constraints — these guard against regressing to that.
describe("yaml-rule-parser faithful structure (#206)", () => {
	it("preserves nested any-of-{kind,has} without flattening", () => {
		const rule = parseSimpleYaml(
			[
				"id: nested",
				"language: TypeScript",
				"rule:",
				"  any:",
				"    - kind: if_statement",
				"      has:",
				"        field: condition",
				"        kind: 'true'",
				"    - kind: ternary_expression",
				"rule_tail: ignore",
			].join("\n"),
		);
		expect(rule?.rule?.any).toHaveLength(2);
		// nesting intact: first alternative keeps its own has (not hoisted/flattened)
		expect(rule?.rule?.any?.[0].kind).toBe("if_statement");
		expect(rule?.rule?.any?.[0].has?.field).toBe("condition");
		expect(rule?.rule?.any?.[0].has?.kind).toBe("true"); // quoted scalar, not boolean
		expect(rule?.rule?.any?.[1].kind).toBe("ternary_expression");
	});

	it("keeps the metavariable key in constraints", () => {
		const rule = parseSimpleYaml(
			[
				"id: secret",
				"language: TypeScript",
				"rule:",
				"  pattern: process.env.$KEY",
				"constraints:",
				"  KEY:",
				'    regex: "SECRET|TOKEN"',
			].join("\n"),
		);
		expect(rule?.constraints?.KEY?.regex).toBe("SECRET|TOKEN");
	});

	it("returns null (not throw) on a malformed document", () => {
		expect(parseSimpleYaml("id: bad\nmessage: !!value oops\n")).toBeNull();
	});
});

// Guard: the rich `pattern` form ({context, selector}) was previously crashing
// the napi runner via `isOverlyBroadPattern` because it called `.trim()` on
// what is actually an object. Any rule with this shape (a project rule, a
// future catalog import, …) would have crashed the runner for that file. The
// fix is two small guards: isOverlyBroadPattern must treat object patterns as
// "not broadly-bare", and isStructuredRule must recognise the rich form as
// structure (so a rule that uses ONLY the rich form is not dropped by the
// runner's "drop unstructured $X-patterns" safety net).
describe("yaml-rule-parser rich pattern form ({context, selector})", () => {
	it("isOverlyBroadPattern returns false for the rich form, true for a bare metavar", () => {
		// Bare $X / $VAR are the trap the helper exists to catch — the rich
		// form is the safe structured alternative.
		expect(isOverlyBroadPattern("$X")).toBe(true);
		expect(isOverlyBroadPattern("$NAME")).toBe(true);
		expect(
			isOverlyBroadPattern({
				context: "class Hi { $METHOD() { $$$ } }",
				selector: "method_definition",
			}),
		).toBe(false);
		// Also: undefined / empty / non-strings must not throw.
		expect(isOverlyBroadPattern(undefined)).toBe(false);
		expect(isOverlyBroadPattern("")).toBe(false);
	});

	it("isStructuredRule recognises a rich pattern as structured", () => {
		const richOnly = {
			id: "rich-only",
			rule: {
				pattern: {
					context: "class Hi { $METHOD() { $$$ } }",
					selector: "method_definition",
				},
				inside: { stopBy: "end", pattern: "class $KLASS $$$ { $$$ }" },
			},
		};
		expect(isStructuredRule(richOnly)).toBe(true);
	});
});
