import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadYamlRules } from "../../../../clients/dispatch/runners/yaml-rule-parser.js";

// The shipped ast-grep rule that flags catastrophic-backtracking (ReDoS) regex
// literals: an unbounded quantifier nested inside an unbounded-quantified group.
const RULES_DIR = path.resolve(
	__dirname,
	"../../../../rules/ast-grep-rules/rules",
);

function loadRule() {
	const rules = loadYamlRules(RULES_DIR);
	const rule = rules.find((r) => r.id === "redos-nested-quantifier");
	if (!rule) throw new Error("redos-nested-quantifier rule not found");
	return rule;
}

// Regex literal patterns that SHOULD be flagged: a SINGLE quantified atom (char,
// class, escape, or dot) nested inside another unbounded repetition.
const VULNERABLE = [
	"(a+)+$", // classic exponential — S5852 sensitive example
	"(a*)*$",
	"([a-z]+)*", // char-class atom
	"(\\d+){2,}", // escaped atom, unbounded outer via {n,}
	"(a{2,})+", // unbounded inner via {n,}
	"(.*)+", // dot atom
	"(?:.*)*", // non-capturing group
	"(\\w+)*$",
];

// Patterns that must NOT be flagged (linear, bounded, or unique-partition).
const SAFE = [
	"a+b+", // separate, non-nested
	"(ab)+", // group body has no quantifier
	"[a-z]+",
	"^\\d{1,5}$", // bounded
	"(a{2,3}){4,5}", // both bounded — S5852 says this is the fix
	"(foo|bar)",
	"(a+)(b)+", // two separate quantified groups, not nested
	"\\s*,", // single quantifier
	// Mandatory-prefix groups: partition is unique, so no backtracking
	// (S5852 explicitly calls (ba+)+ safe).
	"(ba+)+",
	"(ab+)+",
	"(?:ab+)+x",
	"(-[a-z0-9]+){3,}",
	"^[a-z][a-z0-9]*(-[a-z0-9]+){3,}$", // real codebase pattern (quality-rules.ts)
];

describe("redos-nested-quantifier rule", () => {
	it("is well-formed and loads through the production parser", () => {
		const rule = loadRule();
		expect(rule.language).toBe("TypeScript");
		expect(rule.severity).toBe("warning");
		expect(rule.metadata?.category).toBe("security");
		expect(rule.rule?.kind).toBe("regex_pattern");
		expect(rule.rule?.regex).toBeTruthy();
		// note drives the actionable fixSuggestion — must be present
		expect(rule.note).toMatch(/backtracking|ReDoS|bounded/i);
	});

	// Mirror the napi runner's matching exactly: new RegExp(rule.regex).test(text)
	// against each regex_pattern node's text (ast-grep-napi.ts).
	it("flags catastrophic-backtracking patterns", () => {
		const re = new RegExp(loadRule().rule!.regex!);
		for (const pattern of VULNERABLE) {
			expect(re.test(pattern), `should flag: ${pattern}`).toBe(true);
		}
	});

	it("does not flag linear or bounded patterns", () => {
		const re = new RegExp(loadRule().rule!.regex!);
		for (const pattern of SAFE) {
			expect(re.test(pattern), `should NOT flag: ${pattern}`).toBe(false);
		}
	});

	it("uses a linear detector (no unbounded repetition that could itself ReDoS)", () => {
		// The detector regex must not contain greedy . or nested quantifiers that
		// could make the ReDoS check itself vulnerable. \)+ is safe because ) and
		// the surrounding quantifier classes do not overlap.
		const src = loadRule().rule!.regex!;
		expect(src).not.toContain(".*");
		expect(src).not.toContain(".+");
	});
});
