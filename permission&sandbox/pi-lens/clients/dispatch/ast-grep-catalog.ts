/**
 * The effective ast-grep rule catalog for a workspace root (#3053).
 *
 * Before this module, `clients/dispatch/runners/ast-grep-napi.ts` (the NAPI
 * runner) and `clients/dispatch/rule-ignores.ts` (the LSP-seam matcher, #3041)
 * each walked `getAstGrepRuleSources(root)` and resolved rule-id precedence
 * independently — two implementations of the same derivation. They had
 * already drifted once by the time #3053 was filed: #3046 round 2 found the
 * LSP seam claiming an id only when the winning document declared `ignores`,
 * so a project rule that redefines a bundled id with NO `ignores` fired
 * per-edit (the runner) but stayed carved out over LSP (the seam) — the same
 * defect the whole PR existed to remove, just inverted. This module is the
 * one place that walk and that precedence rule now live.
 *
 * Precedence: sources are walked in `getAstGrepRuleSources`'s order (project
 * primary, project secondary, bundled primary, bundled secondary), each
 * loaded with the same loader the runner always used (`loadYamlRulesFresh`
 * for mutable project trees, `loadYamlRules`'s mtime-cached path for
 * immutable bundled catalogs). The FIRST rule sighted for an id — scanning
 * sources in order, and each source's own rules in file order — claims it;
 * no later document for the same id is ever consulted.
 *
 * Deliberately does NOT special-case an id that recurs WITHIN one source's
 * own rule list. That is `duplicateRuleIds` in ast-grep-napi.ts, a
 * runner-only concern layered on top of this catalog's plain result: the
 * runner drops such an id entirely (one Duplicate-rule-id diagnostic, no
 * rule fires for it), but `materializeMergedRuleDir` (clients/sgconfig.ts) —
 * what ast-grep's own LSP binary actually runs — keeps every document an
 * EARLIER source hasn't already claimed, so both copies of a within-source
 * duplicate still survive into what ast-grep publishes over LSP. Baking the
 * runner's drop into this catalog would leave those published findings with
 * no registered `ignores` at all, silently unsuppressed — reopening #3041 for
 * that id (#3046 round 2 F7). So the catalog resolves a within-source
 * duplicate to its first-sighted document like any other collision, and it
 * is each consumer's job to decide what a within-source duplicate means for
 * it — the runner still computes `duplicateRuleIds` itself and skips those
 * ids before ever consulting this catalog's answer for them.
 */

import type { AstGrepRuleSource } from "../sgconfig.js";
import { getAstGrepRuleSources } from "../sgconfig.js";
import {
	loadYamlRules,
	loadYamlRulesFresh,
	type YamlRule,
} from "./runners/yaml-rule-parser.js";

/** One rule source's rules, loaded once, in the walk's precedence order. */
export interface AstGrepCatalogSource {
	readonly source: AstGrepRuleSource;
	readonly rules: readonly YamlRule[];
}

/** A rule id's winning (first-sighted) document and the source that claimed it. */
export interface AstGrepCatalogEntry {
	readonly rule: YamlRule;
	readonly source: AstGrepRuleSource;
}

export interface EffectiveAstGrepCatalog {
	/** Every source that produced rules, in the walk's precedence order. */
	readonly sources: readonly AstGrepCatalogSource[];
	/** Rule id -> its first-sighted document and claiming source. */
	readonly effectiveRules: ReadonlyMap<string, AstGrepCatalogEntry>;
}

/**
 * Build the effective ast-grep catalog for `root`. See the module docstring
 * for the precedence rule and the within-source-duplicate decision.
 *
 * No try/catch around either loader: every I/O path inside them already
 * swallows its own failure (missing dir, unreadable readdir, unreadable file
 * all yield an empty list — `yaml-rule-parser.ts`'s `findYamlRuleFiles` and
 * `loadYamlRuleFiles`), so a catch here would be a guard no mutation can red.
 */
export function buildEffectiveAstGrepCatalog(
	root: string,
): EffectiveAstGrepCatalog {
	const sources: AstGrepCatalogSource[] = [];
	const effectiveRules = new Map<string, AstGrepCatalogEntry>();
	for (const source of getAstGrepRuleSources(root)) {
		const rules =
			source.origin === "project"
				? loadYamlRulesFresh(source.dir)
				: loadYamlRules(source.dir);
		sources.push({ source, rules });
		for (const rule of rules) {
			if (effectiveRules.has(rule.id)) continue;
			effectiveRules.set(rule.id, { rule, source });
		}
	}
	return { sources, effectiveRules };
}
