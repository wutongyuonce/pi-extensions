/**
 * Inline `pi-lens-ignore` suppression — shared between the per-edit dispatch
 * pipeline (`lens_diagnostics mode=all`) and the project-wide `mode=full` sweep so
 * BOTH honor the same comments (#442). Previously this lived privately in the
 * dispatcher, so a site suppressed on the write path reappeared as blocking in the
 * full scan, making `mode=full` unusable as a clean gate.
 *
 * Syntax: `// pi-lens-ignore: rule-id` (JS/TS) or `# pi-lens-ignore: rule-id`
 * (Python/Ruby/…), comma-separated for multiple rules, on the same line as the
 * diagnostic or the line immediately above it.
 */

import { normalizeRuleId } from "./rule-id-normalize.js";

export interface SuppressibleDiagnostic {
	line?: number;
	rule?: string;
	id?: string;
}

const SUPPRESS_RE = /(?:\/\/|#)\s*pi-lens-ignore:\s*(.+)/;

/**
 * Normalize a rule id to the form a user writes in a `pi-lens-ignore` comment.
 * The napi scan and the ast-grep LSP tag the same rule as `ast-grep:<id>` /
 * `<id>-js` in some surfaces (see the dedup key in lens-diagnostics);
 * a user's bare `<id>` must still suppress those, so we match the normalized form
 * as well as the raw one. Shared via `rule-id-normalize.ts` so the inline
 * suppression parser and the project rule policy matcher apply the same
 * normalization.
 */

/**
 * Drop diagnostics suppressed by an inline `pi-lens-ignore: <rule[,rule2]>`
 * comment in `content` (the file the diagnostics belong to). A diagnostic is
 * suppressed when its rule id — raw OR normalized — is listed on its own line or
 * the line immediately above. Returns the surviving diagnostics (same array if
 * nothing is suppressed).
 */
export function applyInlineSuppressions<T extends SuppressibleDiagnostic>(
	diagnostics: T[],
	content: string,
): T[] {
	if (!content || !diagnostics.length) return diagnostics;

	// Build the set of (1-based line, rule-id) pairs that are suppressed.
	const suppressed = new Set<string>();
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = SUPPRESS_RE.exec(lines[i]);
		if (!m) continue;
		const rules = m[1]
			.split(",")
			.map((r) => r.trim())
			.filter(Boolean);
		const suppressedLine = i + 1; // same line (1-based)
		const nextLine = i + 2; // next line (1-based)
		for (const ruleId of rules) {
			// #1087: normalize the COMMENT token too, not just the diagnostic id.
			// The diagnostic side below matches raw OR normalized, so storing only
			// the raw comment token made `// pi-lens-ignore: no-eval-js` fail to
			// suppress a finding surfaced under the normalized `no-eval`, while the
			// identical `disable: ["no-eval-js"]` config key worked (rule-policy
			// normalizes both sides). Add the normalized form so the two suppression
			// surfaces stay symmetric.
			for (const key of new Set([ruleId, normalizeRuleId(ruleId)])) {
				suppressed.add(`${suppressedLine}:${key}`);
				suppressed.add(`${nextLine}:${key}`);
			}
		}
	}

	if (suppressed.size === 0) return diagnostics;

	return diagnostics.filter((d) => {
		const rawId = d.rule ?? d.id ?? "";
		const line = d.line ?? 1;
		if (suppressed.has(`${line}:${rawId}`)) return false;
		const normId = normalizeRuleId(rawId);
		return normId === rawId || !suppressed.has(`${line}:${normId}`);
	});
}
