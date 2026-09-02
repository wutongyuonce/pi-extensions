// Coverage guard for #1608: `language: TypeScript` ast-grep rules were
// silently skipped on every `.tsx` file. `evaluateAstGrepRules()`
// (clients/dispatch/runners/ast-grep-napi.ts) compared a rule's declared
// `language` against `ruleLanguageForFile()`'s *exact* result for the
// scanned file — and a `.tsx` file resolves to `"tsx"`, never
// `"typescript"` — so every `TypeScript`-tagged rule's `if (lang &&
// fileLang && lang !== fileLang) continue;` guard fired and the rule
// never ran. Only 3 of 263 shipped rules declare `language: Tsx`, so a
// React/TSX codebase got near-zero ast-grep coverage.
//
// This test derives its rule list from the shipped catalog itself (no
// hand-maintained parallel list — the PR #883 pattern) and reuses each
// rule's existing `rule-tests/<id>-test.yml` fixture (one per rule,
// already required by ast-grep-rule-tests.test.ts) rather than
// hand-writing new tsx snippets per rule. For every `TypeScript`-tagged
// rule, its `invalid:` (must-match) snippets are parsed under the `tsx`
// grammar via napi directly — the same engine + rule shape validated in
// ast-grep-rule-validity.test.ts — and the rule must still fire. That
// proves per-rule pattern compatibility with tsx (the issue's "verify
// pattern compatibility per rule rather than assuming") instead of just
// asserting the wiring is enabled.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, Lang } from "@ast-grep/napi";
import * as yaml from "js-yaml";
import {
	canHandle,
	evaluateAstGrepRules,
	ruleLanguageForFile,
} from "../../../../clients/dispatch/runners/ast-grep-napi.js";

const RULES_DIR = path.join(process.cwd(), "rules", "ast-grep-rules", "rules");
const TEST_DIR = path.join(
	process.cwd(),
	"rules",
	"ast-grep-rules",
	"rule-tests",
);

interface RawRule {
	id?: string;
	language?: string;
	rule?: unknown;
	constraints?: unknown;
	utils?: unknown;
}

interface RuleFixture {
	id?: string;
	valid?: string[];
	invalid?: string[];
}

function loadRawRules(): { file: string; doc: RawRule }[] {
	return fs
		.readdirSync(RULES_DIR)
		.filter((f) => f.endsWith(".yml"))
		.map((file) => ({
			file,
			doc: yaml.load(
				fs.readFileSync(path.join(RULES_DIR, file), "utf8"),
			) as RawRule,
		}))
		.filter((r) => r.doc && r.doc.id && r.doc.rule);
}

function loadFixture(id: string): RuleFixture | undefined {
	const fixturePath = path.join(TEST_DIR, `${id}-test.yml`);
	if (!fs.existsSync(fixturePath)) return undefined;
	return yaml.load(fs.readFileSync(fixturePath, "utf8")) as RuleFixture;
}

describe("ruleLanguageForFile (#1608)", () => {
	it("still resolves .tsx to its own grammar, distinct from .ts", () => {
		expect(ruleLanguageForFile("Component.tsx")).toBe("tsx");
		expect(ruleLanguageForFile("module.ts")).toBe("typescript");
	});

	it.each([["App.java"], ["App.kt"], ["build.gradle.kts"]] as const)(
		"does not route polyglot files through the NAPI grammar seam",
		(file) => {
			expect(canHandle(file)).toBe(false);
			expect(ruleLanguageForFile(file)).toBeUndefined();
		},
	);
});

describe("shipped TypeScript rules retain tsx coverage (#1608)", () => {
	const tsRules = loadRawRules().filter(
		(r) => (r.doc.language ?? "").toLowerCase() === "typescript",
	);

	it("finds a substantial TypeScript-language rule set to guard", () => {
		// Regression guard on the guard itself: if this collapses to ~0,
		// the loader/filter above broke, not the catalog.
		expect(tsRules.length).toBeGreaterThan(100);
	});

	const missingFixture: string[] = [];
	const uncoveredOnTsx: string[] = [];

	for (const { doc } of tsRules) {
		const id = doc.id as string;
		const fixture = loadFixture(id);
		if (!fixture) {
			missingFixture.push(id);
			continue;
		}
		const invalidSnippets = fixture.invalid ?? [];
		if (invalidSnippets.length === 0) continue;

		const firesOnTsx = invalidSnippets.some((snippet) => {
			try {
				const root = parse(Lang.Tsx, snippet).root();
				const cfg: Record<string, unknown> = { rule: doc.rule };
				if (doc.constraints) cfg.constraints = doc.constraints;
				if (doc.utils) cfg.utils = doc.utils;
				return root.findAll(cfg as never).length > 0;
			} catch {
				return false;
			}
		});
		if (!firesOnTsx) uncoveredOnTsx.push(id);
	}

	it("every TypeScript rule is discoverable via its rule-tests fixture", () => {
		expect(missingFixture).toEqual([]);
	});

	it("every TypeScript rule's invalid fixture still matches parsed as tsx", () => {
		expect(uncoveredOnTsx).toEqual([]);
	});
});

// The wiring test: does the runner's actual language filter (not just the
// engine's pattern compatibility, above) let a `TypeScript`-tagged rule
// through for a `.tsx` file? Uses the real shipped catalog via
// `evaluateAstGrepRules` — the same function the per-edit runner and the
// project-wide scanner both call — against a real tsx-parsed root, no
// mocking. `kind` is left as a non-"jsts" sentinel so the eslint-overlap
// suppression path (irrelevant to this guard) never engages regardless of
// the checkout's own eslint config.
describe("evaluateAstGrepRules runs TypeScript rules against .tsx files (#1608)", () => {
	it("array-callback-return (language: TypeScript) fires on a .tsx file", () => {
		const filePath = path.join(process.cwd(), "Component.tsx");
		const code = "const r = items.map(x => { x + 1 });\n";
		const rootNode = parse(Lang.Tsx, code).root();

		const diagnostics = evaluateAstGrepRules(
			filePath,
			rootNode,
			process.cwd(),
			"tsx-coverage-guard",
		);

		expect(diagnostics.some((d) => d.rule === "array-callback-return")).toBe(
			true,
		);
	}, 10_000);
});
