/**
 * Normalize a rule id to the form a user typically writes in a
 * `pi-lens-ignore` comment, an inline suppression, or a project-level
 * `disable`/`select` list. Strips the `ast-grep:` LSP source prefix and the
 * language suffix used by the rule catalogs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAstGrepRuleSources } from "../sgconfig.js";

/** Derive language tags from shipped rule filenames, rather than a list. */
export function deriveRuleIdLanguageSuffixes(ruleRoot: string): Set<string> {
	const suffixes = new Set<string>();
	const visit = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else {
				const match = /-([a-z0-9]+)\.ya?ml$/i.exec(entry.name);
				if (match) suffixes.add(match[1].toLowerCase());
			}
		}
	};
	visit(ruleRoot);
	return suffixes;
}

const bundledCodeRabbitRules = getAstGrepRuleSources().find(
	(source) => source.origin === "bundled" && source.tier === "secondary",
);
const RULE_ID_LANGUAGE_SUFFIXES = new Set(["js"]);
if (bundledCodeRabbitRules) {
	for (const suffix of deriveRuleIdLanguageSuffixes(
		bundledCodeRabbitRules.dir,
	)) {
		RULE_ID_LANGUAGE_SUFFIXES.add(suffix);
	}
}

export function normalizeRuleId(ruleId: string): string {
	const normalized = ruleId.replace(/^ast-grep:/, "");
	for (const suffix of RULE_ID_LANGUAGE_SUFFIXES) {
		if (normalized.endsWith(`-${suffix}`)) {
			return normalized.slice(0, -(suffix.length + 1));
		}
	}
	return normalized;
}
