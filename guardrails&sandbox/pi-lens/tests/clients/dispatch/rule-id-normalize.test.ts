/**
 * Tests for the shared rule-id normalization
 * (`clients/dispatch/rule-id-normalize.ts`). The same strip pipeline
 * (`ast-grep:` prefix + `-js` suffix) is consumed by:
 *
 * - `clients/dispatch/inline-suppressions.ts` (matches `pi-lens-ignore` comments)
 * - `clients/dispatch/rule-policy.ts` (matches `disable`/`select` list entries)
 * - `tools/lens-diagnostics.ts` (dedup in mode=full merge)
 *
 * Diverging them would let a single user-facing rule id (e.g. `no-eval`)
 * silently drop protection across the three surfaces. These tests probe
 * the contract the matcher guarantees.
 */
import { describe, expect, it } from "vitest";
import {
	deriveRuleIdLanguageSuffixes,
	normalizeRuleId,
} from "../../../clients/dispatch/rule-id-normalize.js";

const CODERABBIT_RULES_DIR = "rules/ast-grep-rules/coderabbit/rules";

describe("rule-id-normalize", () => {
	it("strips the ast-grep: prefix", () => {
		expect(normalizeRuleId("ast-grep:no-eval")).toBe("no-eval");
	});

	it("strips the -js suffix", () => {
		expect(normalizeRuleId("no-eval-js")).toBe("no-eval");
	});

	it("covers every language suffix present in the bundled CodeRabbit tree", () => {
		const suffixes = deriveRuleIdLanguageSuffixes(CODERABBIT_RULES_DIR);
		for (const suffix of suffixes) {
			expect(normalizeRuleId(`rule-${suffix}`)).toBe("rule");
		}
	});

	it("strips both forms (ast-grep: prefix + -js suffix)", () => {
		expect(normalizeRuleId("ast-grep:no-eval-js")).toBe("no-eval");
	});

	it("is a no-op on a bare rule id", () => {
		expect(normalizeRuleId("no-eval")).toBe("no-eval");
	});

	it("is idempotent (normalize is a fixed point)", () => {
		const forms = [
			"no-eval",
			"ast-grep:no-eval",
			"no-eval-js",
			"ast-grep:no-eval-js",
		];
		for (const form of forms) {
			const once = normalizeRuleId(form);
			const twice = normalizeRuleId(once);
			expect(twice).toBe(once);
		}
	});

	it("does NOT strip a substring -js (only the trailing suffix)", () => {
		// `-js` mid-id is part of the rule name, not a language suffix.
		// The regex `.replace(/-js$/, "")` only matches the trailing suffix.
		expect(normalizeRuleId("no-js-comment")).toBe("no-js-comment");
		expect(normalizeRuleId("jsdoc-extra")).toBe("jsdoc-extra");
	});

	it("collapses a distinct rule literally named '<stem>-js' onto its stem (documented conflation)", () => {
		// `normalizeRuleId` can't tell a language-tag `-js` suffix (the napi
		// variant of `no-eval`, i.e. `no-eval-js`) apart from a `-js` that's
		// part of a rule's own name. A rule genuinely named `prefer-js`
		// normalizes to the same "prefer" as an unrelated `prefer` rule — a
		// deliberate side effect of the shared strip, not a bug. See this
		// module's doc comment and docs/globalconfig.md.
		expect(normalizeRuleId("prefer-js")).toBe(normalizeRuleId("prefer"));
		expect(normalizeRuleId("prefer-js")).toBe("prefer");
	});
});
