import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, Lang } from "@ast-grep/napi";
import * as yaml from "js-yaml";

// Guards the #239 Phase-2 invariant: EVERY shipped ast-grep rule must be
// accepted by napi's native engine (root.findAll) — the SAME Rust core the
// ast-grep CLI and LSP use. A rule the engine rejects (invalid kind matcher,
// malformed `rule`) is doubly dangerous: napi's findAll throws → the napi runner
// silently catches it and the rule dies producing NOTHING; and the ast-grep
// CLI/LSP loader (Phase 2's engine) FAILS HARD on the first bad rule in
// `ruleDirs`, aborting the entire scan and taking every other rule with it.
// (e.g. kind `conditional_expression` → must be `ternary_expression`.)
//
// We load each rule file with raw YAML (full fidelity, incl. `utils:`) and
// validate it exactly as the LSP loader would — one rule per file.

const RULES_DIR = path.join(process.cwd(), "rules", "ast-grep-rules", "rules");

// napi's base bundle types only the JS/TS family — Python rules are LSP-only
// (the napi runner skips non-ts/js languages too), so they're not validated
// here; the CLI/LSP loads them (verified separately via `ast-grep scan`).
const LANG_BY_NAME: Record<string, Lang> = {
	typescript: Lang.TypeScript,
	javascript: Lang.JavaScript,
	tsx: Lang.Tsx,
};
const SNIPPET_BY_LANG = new Map<Lang, string>([
	[Lang.TypeScript, "const x = 1;\n"],
	[Lang.JavaScript, "const x = 1;\n"],
	[Lang.Tsx, "const x = 1;\n"],
]);

interface RawRule {
	id?: string;
	language?: string;
	rule?: unknown;
	constraints?: unknown;
	utils?: unknown;
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

describe("shipped ast-grep rules are all engine-valid (#239)", () => {
	const rules = loadRawRules();

	it("loads the full shipped rule set (slop split into ./rules)", () => {
		expect(rules.length).toBeGreaterThan(180);
	});

	const rejected: string[] = [];
	for (const { doc } of rules) {
		const lang = LANG_BY_NAME[(doc.language || "typescript").toLowerCase()];
		if (lang === undefined) continue; // language napi can't load here — skip
		try {
			const root = parse(lang, SNIPPET_BY_LANG.get(lang) ?? "x;\n").root();
			const cfg: Record<string, unknown> = { rule: doc.rule };
			if (doc.constraints) cfg.constraints = doc.constraints;
			if (doc.utils) cfg.utils = doc.utils;
			root.findAll(cfg as never);
		} catch (e) {
			rejected.push(`${doc.id}: ${(e as Error).message.split("\n")[0]}`);
		}
	}

	it("every rule is accepted by the native engine (no invalid-kind/malformed rule)", () => {
		expect(rejected).toEqual([]);
	});
});

// The two slop rules split out broken (kind `conditional_expression`, fixed →
// `ternary_expression`): dead in napi, would have aborted the LSP loader. Assert
// they now match.
describe("reactivated slop ternary rules fire (#239 Finding A)", () => {
	const fired = (code: string, ruleId: string): boolean => {
		const doc = yaml.load(
			fs.readFileSync(path.join(RULES_DIR, `${ruleId}.yml`), "utf8"),
		) as RawRule;
		const root = parse(Lang.TypeScript, code).root();
		return root.findAll({ rule: doc.rule } as never).length > 0;
	};

	it("ts-nullish-coalescing-opportunity flags `x !== null && x !== undefined ? x : d`", () => {
		expect(
			fired(
				"const r = a !== null && a !== undefined ? a : d;\n",
				"ts-nullish-coalescing-opportunity",
			),
		).toBe(true);
	});

	it("ts-optional-chaining-default flags `obj && obj.prop ? obj.prop : d`", () => {
		expect(
			fired(
				"const r = obj && obj.prop ? obj.prop : d;\n",
				"ts-optional-chaining-default",
			),
		).toBe(true);
	});
});
