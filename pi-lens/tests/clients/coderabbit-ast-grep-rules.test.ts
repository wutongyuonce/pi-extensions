import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as yaml from "js-yaml";
import { resolveAstGrepNativeExe } from "../../clients/lsp/wait-policy/index.js";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { getAstGrepRuleSources } from "../../clients/sgconfig.js";
import { setupTestEnvironment } from "./test-utils.js";

const CODERABBIT_ROOT = path.join(
	process.cwd(),
	"rules",
	"ast-grep-rules",
	"coderabbit",
);
const CODERABBIT_RULES_DIR = path.join(CODERABBIT_ROOT, "rules");
const CODERABBIT_LICENSE = path.join(CODERABBIT_ROOT, "LICENSE");

interface RawAstGrepRule {
	id?: unknown;
	severity?: unknown;
	utils?: unknown;
	rule?: unknown;
}

function collectRuleFiles(dir = CODERABBIT_RULES_DIR): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectRuleFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".yml")) files.push(full);
	}
	return files;
}

function collectMatchesRefs(node: unknown, refs: string[] = []): string[] {
	if (Array.isArray(node)) {
		for (const item of node) collectMatchesRefs(item, refs);
		return refs;
	}
	if (!node || typeof node !== "object") return refs;
	for (const [key, value] of Object.entries(node)) {
		if (key === "matches" && typeof value === "string") refs.push(value);
		else collectMatchesRefs(value, refs);
	}
	return refs;
}

const ruleFiles = collectRuleFiles();
const parsedRules = ruleFiles.map((file) => ({
	file,
	doc: yaml.load(fs.readFileSync(file, "utf8"), {
		schema: yaml.JSON_SCHEMA,
	}) as RawAstGrepRule,
}));

describe("vendored CodeRabbit ast-grep rules", () => {
	it("vendors the full upstream ruleset", () => {
		expect(ruleFiles.length).toBe(184);
		expect(fs.existsSync(CODERABBIT_LICENSE)).toBe(true);
	});

	it("preserves CodeRabbit severities instead of promoting every rule to error", () => {
		const byId = new Map(parsedRules.map(({ doc }) => [String(doc.id), doc]));
		expect(byId.get("dont-call-system-c")?.severity).toBe("warning");
		expect(byId.get("unencrypted-socket-java")?.severity).toBe("info");
		// This upstream rule intentionally omits severity; preserve that too.
		expect(byId.get("cookie-httponly-false-java")?.severity).toBeUndefined();
	});

	it("normalizes utility ids and rewrites matches refs to ast-grep-safe names", () => {
		const unsafeUtilityIds: string[] = [];
		const unresolvedRefs: string[] = [];
		for (const { file, doc } of parsedRules) {
			const utils =
				doc.utils && typeof doc.utils === "object" && !Array.isArray(doc.utils)
					? (doc.utils as Record<string, unknown>)
					: undefined;
			if (!utils) continue;
			const utilityIds = new Set(Object.keys(utils));
			for (const id of utilityIds) {
				if (!/^[A-Za-z0-9_-]+$/.test(id)) {
					unsafeUtilityIds.push(
						`${path.relative(CODERABBIT_RULES_DIR, file)}:${id}`,
					);
				}
			}
			for (const ref of collectMatchesRefs(doc.rule)) {
				if (!utilityIds.has(ref)) {
					unresolvedRefs.push(
						`${path.relative(CODERABBIT_RULES_DIR, file)}:${ref}`,
					);
				}
			}
		}
		expect(unsafeUtilityIds).toEqual([]);
		expect(unresolvedRefs).toEqual([]);
	});

	it("parses and runs every sgconfig-shipped rule through the real engine", () => {
		const source = getAstGrepRuleSources(process.cwd()).find(
			(entry) => entry.origin === "bundled" && entry.tier === "secondary",
		);
		expect(source?.dir).toBe(CODERABBIT_RULES_DIR);
		expect(collectRuleFiles(source!.dir)).toHaveLength(184);

		const env = setupTestEnvironment("pi-lens-coderabbit-smoke-");
		try {
			const fixtures = path.join(env.tmpDir, "fixtures");
			fs.mkdirSync(fixtures);
			const extensions = [
				"c",
				"cpp",
				"cs",
				"go",
				"html",
				"java",
				"js",
				"kt",
				"php",
				"py",
				"rb",
				"rs",
				"scala",
				"swift",
				"ts",
			];
			for (const extension of extensions) {
				fs.writeFileSync(path.join(fixtures, `empty.${extension}`), "");
			}
			const relativeRuleDir = path
				.relative(env.tmpDir, source!.dir)
				.replace(/\\/g, "/");
			const configPath = path.join(env.tmpDir, "sgconfig.yml");
			fs.writeFileSync(
				configPath,
				`ruleDirs:\n  - ${JSON.stringify(relativeRuleDir)}\n`,
			);
			const astGrepExe = resolveAstGrepNativeExe();
			expect(astGrepExe).toBeDefined();

			// #902: was `execFileSync(..., { shell: true })`-adjacent raw spawn.
			// `astGrepExe` is already an absolute path resolved via
			// `require.resolve` (no PATH/PATHEXT walk needed), but routing it
			// through `safeSpawn` (shared with production, `clients/safe-spawn.ts`)
			// keeps a single spawn strategy for every ast-grep invocation in this
			// test tree (single source of truth, #883) instead of a second,
			// hand-rolled one here.
			const result = safeSpawn(
				astGrepExe!,
				["scan", "--config", configPath, fixtures],
				{ cwd: env.tmpDir },
			);
			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
		} finally {
			env.cleanup();
		}
	}, 30_000);
});
