// Audits rules/ast-grep-rules/rules/ for accidental duplicate `rule:` bodies
// across different rule files (#657). Neither existing rule-audit script fits
// this seam: validate-rule-catalog.mjs validates the SEPARATE tree-sitter
// rule-catalog.json (canonical_concept grouping, out of scope for #657), and
// audit-tree-sitter-rules.mjs only walks rules/tree-sitter-queries. This is a
// small standalone script over rules/ast-grep-rules/rules instead.
//
// Context: a `language: TypeScript` rule and a `language: JavaScript` rule
// with an IDENTICAL `rule:` body both fire on a `.ts` file in the in-process
// NAPI runner if their body uses grammar-superset-compatible node kinds
// (confirmed: hardcoded-url / hardcoded-url-js, issue #657). The runner fix
// (clients/dispatch/runners/ast-grep-napi.ts `ruleLanguageForFile` scoping)
// closes this structurally for ANY such pair going forward, so this script is
// a catalog-hygiene check, not the primary regression guard (that's the
// runner-level vitest test in
// tests/clients/ast-grep-rule-precedence-followups.test.ts).
//
// What this script actually flags (real problems, not the intentional
// TS/JS-twin convention documented in skills/pi-lens-write-ast-grep-rule):
//   - two rule files with the IDENTICAL `rule:` body under the SAME
//     `language:` tag (a true redundant duplicate — always wasteful, never
//     intentional).
//   - a `<base>.yml` / `<base>-js.yml` twin pair with identical `rule:` bodies
//     whose `language:` tags are NOT exactly {TypeScript, JavaScript} (i.e.
//     doesn't match the documented twin convention — could be a copy/paste
//     mistake under an unexpected pair of languages).
//   - a `<base>.yml` / `<base>-js.yml` twin pair with identical `rule:`
//     bodies but DIVERGENT `message`/`severity` (drift risk: one side gets
//     tuned and the other silently doesn't).
//
// Everything else (identical-body TS/JS twins with matching message and
// severity) is the intentional, documented pattern and is reported but not
// flagged as an error.

import fs from "node:fs";
import path from "node:path";

const STRICT = process.argv.includes("--strict");
const root = process.cwd();
const rulesDir = path.join(root, "rules", "ast-grep-rules", "rules");

function readField(text, key) {
	const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
}

function extractRuleBlock(text) {
	const lines = text.split(/\r?\n/);
	const out = [];
	let capturing = false;
	for (const line of lines) {
		if (!capturing) {
			if (/^rule:\s*$/.test(line)) {
				capturing = true;
				out.push(line);
			}
			continue;
		}
		if (line.trim() === "") {
			out.push(line);
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (indent === 0) break;
		out.push(line);
	}
	return out.join("\n").trim();
}

if (!fs.existsSync(rulesDir)) {
	console.error(`[astgrep-rule-pairs] missing ${rulesDir}`);
	process.exit(1);
}

const files = fs
	.readdirSync(rulesDir)
	.filter((f) => f.endsWith(".yml"))
	.sort();

const parsed = files.map((file) => {
	const text = fs.readFileSync(path.join(rulesDir, file), "utf8");
	return {
		file,
		id: readField(text, "id"),
		language: (readField(text, "language") || "").toLowerCase(),
		message: readField(text, "message"),
		severity: readField(text, "severity"),
		ruleBody: extractRuleBlock(text),
	};
});

const errors = [];
const notes = [];

// 1. Same-language exact duplicates — never intentional.
const byLangBody = new Map();
for (const rule of parsed) {
	if (!rule.ruleBody) continue;
	const key = `${rule.language}::${rule.ruleBody}`;
	const prev = byLangBody.get(key);
	if (prev) {
		errors.push(
			`identical rule body under the SAME language ('${rule.language}') in '${prev.file}' and '${rule.file}' — true duplicate, consolidate to one file`,
		);
	} else {
		byLangBody.set(key, rule);
	}
}

// 2. <base>.yml / <base>-js.yml twin convention checks.
const byFile = new Map(parsed.map((r) => [r.file, r]));
for (const rule of parsed) {
	if (!rule.file.endsWith("-js.yml")) continue;
	const baseFile = rule.file.replace(/-js\.yml$/, ".yml");
	const base = byFile.get(baseFile);
	if (!base) continue; // no twin, nothing to check

	const bodiesMatch = base.ruleBody === rule.ruleBody;
	if (!bodiesMatch) {
		notes.push(
			`${baseFile} / ${rule.file}: rule bodies differ (expected — leave alone)`,
		);
		continue;
	}

	const languages = [base.language, rule.language].sort();
	const isCanonicalTwin =
		languages.length === 2 &&
		languages[0] === "javascript" &&
		languages[1] === "typescript";
	if (!isCanonicalTwin) {
		errors.push(
			`${baseFile} / ${rule.file}: identical rule bodies but language tags are ['${base.language}', '${rule.language}'] — not the documented {TypeScript, JavaScript} twin convention (skills/pi-lens-write-ast-grep-rule)`,
		);
		continue;
	}

	if (base.message !== rule.message || base.severity !== rule.severity) {
		errors.push(
			`${baseFile} / ${rule.file}: identical rule bodies but message/severity have drifted (message: '${base.message}' vs '${rule.message}', severity: '${base.severity}' vs '${rule.severity}')`,
		);
		continue;
	}

	notes.push(
		`${baseFile} / ${rule.file}: identical rule body — intentional TS/JS twin (#657, dispatch-scoped by file extension in ast-grep-napi.ts)`,
	);
}

const report = {
	rulesScanned: parsed.length,
	twinsAudited: notes.filter((n) => n.includes("intentional TS/JS twin"))
		.length,
	errors: errors.length,
	notes: notes.length,
	strict: STRICT,
};

console.log(JSON.stringify(report, null, 2));
for (const note of notes) console.log(`[astgrep-rule-pairs][note] ${note}`);
for (const err of errors) console.error(`[astgrep-rule-pairs][error] ${err}`);

if (errors.length > 0) process.exit(1);
