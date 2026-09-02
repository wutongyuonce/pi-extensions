import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const AUDIT = path.join(REPO_ROOT, "scripts/audit-astgrep-rule-pairs.mjs");
const CATALOG = path.join(REPO_ROOT, "scripts/validate-rule-catalog.mjs");
const tempDirs: string[] = [];

function makeTempRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-case-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("rule tooling language comparisons", () => {
	// PINS EXISTING BEHAVIOR, not this PR's change: the audit script has
	// normalized language at parse since af7605f8 (#657, line 85), so this
	// case is green on master. It stays as a regression net against anyone
	// removing that parse-site lowercase. #2331's audit half was a review
	// false positive, corrected in the #2339 review.
	it("reports an identical-body duplicate across Python and python", () => {
		const root = makeTempRepo();
		const rules = path.join(root, "rules", "ast-grep-rules", "rules");
		fs.mkdirSync(rules, { recursive: true });
		const rule = (language: string) =>
			`id: synthetic-${language}\nlanguage: ${language}\nrule:\n  pattern: duplicate($X)\nmessage: duplicate\nseverity: warning\n`;
		fs.writeFileSync(path.join(rules, "a.yml"), rule("Python"));
		fs.writeFileSync(path.join(rules, "b.yml"), rule("python"));

		const result = spawnSync(process.execPath, [AUDIT], {
			cwd: root,
			encoding: "utf8",
		});
		const output = `${result.stdout}${result.stderr}`;

		expect(output).toContain("true duplicate");
		expect(output).toContain("a.yml");
		expect(output).toContain("b.yml");
	});

	it("warns about catalog overlap across Python and python", () => {
		const root = makeTempRepo();
		fs.mkdirSync(path.join(root, "rules"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "rules", "rule-catalog.json"),
			JSON.stringify({
				entries: [
					{
						rule_id: "one",
						engine: "architect",
						language: "Python",
						family: "security",
						scope: "file",
						canonical_concept: "same",
						severity_default: "warning",
						confidence: "high",
						status: "active",
					},
					{
						rule_id: "two",
						engine: "architect",
						language: "python",
						family: "security",
						scope: "file",
						canonical_concept: "same",
						severity_default: "warning",
						confidence: "high",
						status: "active",
					},
				],
			}),
		);

		const result = spawnSync(process.execPath, [CATALOG], {
			cwd: root,
			encoding: "utf8",
		});
		const output = `${result.stdout}${result.stderr}`;
		expect(output).toContain("possible overlap for python::file::same");
		expect(output).toContain("'one' and 'two'");
	});

	// The review's F2: the overlap key's toLowerCase crashed on an entry
	// missing its language field, so the validator died before printing the
	// missing-field error it had already detected. The guard must keep the
	// script alive to report.
	it("reports a missing language field instead of crashing", () => {
		const root = makeTempRepo();
		fs.mkdirSync(path.join(root, "rules"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "rules", "rule-catalog.json"),
			JSON.stringify({
				entries: [
					{
						rule_id: "no-lang",
						engine: "architect",
						family: "security",
						scope: "file",
						canonical_concept: "same",
						severity_default: "warning",
						confidence: "high",
						status: "active",
					},
				],
			}),
		);

		const result = spawnSync(process.execPath, [CATALOG], {
			cwd: root,
			encoding: "utf8",
		});
		const output = `${result.stdout}${result.stderr}`;
		expect(output).not.toContain("TypeError");
		expect(output).toContain("missing required field 'language'");
	});
});
