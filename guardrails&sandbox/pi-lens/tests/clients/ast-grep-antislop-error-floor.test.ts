// #1727 / #1777: the anti-slop error floor.
//
// `error` is the only ast-grep severity that maps to semantic "blocking" in
// the dispatch path, so promoting a rule to `error` turns it into a
// turn-stopper. AGENTS.md's severity policy admits a rule only with a
// documented zero-false-positive audit. This suite pins the three things that
// audit rests on, so a later edit cannot quietly move a rule across the line:
//
//   1. the tier each anti-slop rule actually declares;
//   2. that every `error`-tier anti-slop rule is wired into the CI self-scan
//      (an error rule that never runs against pi-lens's own tree is an
//      unaudited claim);
//   3. that `require-safety-comment-for-as-unknown-as`'s test-path scoping is
//      load-bearing, and that it and `no-chained-type-assertions` PARTITION
//      the assertion space instead of both reporting the same site.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { removeTempDirSync } from "./test-utils.js";
import {
	rulesDir,
	runSelfScan,
	selfScanRuleIds,
} from "../../scripts/lib/astgrep-self-scan.mjs";

/** Every #1727 anti-slop rule and the tier it is meant to ship at. */
const ANTI_SLOP_TIERS: ReadonlyArray<readonly [string, string]> = [
	// Promoted / already at the error floor.
	["no-unsafe-dictionary-any", "error"],
	["no-bare-object-param", "error"],
	["no-chained-type-assertions", "error"],
	["require-safety-comment-for-as-unknown-as", "error"],
	["no-unknown-laundering", "error"],
	["no-unknown-returns", "error"],
	// Considered for the floor on 2026-08-20 and deliberately left at hint.
	// Each rule's note carries the four-corpus census behind that decision.
	["no-known-value-widening", "hint"],
	["no-runtime-typeof", "hint"],
	["no-shape-in-symbol-names", "hint"],
	["no-unknown-parameters", "hint"],
	["no-unsafe-dictionary-unknown", "hint"],
];

function ruleText(id: string): string {
	return fs.readFileSync(path.join(rulesDir(), `${id}.yml`), "utf8");
}

function declaredSeverity(id: string): string | undefined {
	return /^severity:\s*(\S+)/m.exec(ruleText(id))?.[1];
}

describe("anti-slop severity tiers (#1727, #1777)", () => {
	it.each(ANTI_SLOP_TIERS)("%s ships at %s", (id, severity) => {
		expect(declaredSeverity(id)).toBe(severity);
	});

	it("every error-tier anti-slop rule runs in the CI self-scan", () => {
		// The self-scan is what makes an `error` promotion honest: the rule is
		// held at zero on pi-lens's own tree by CI, not by a note claiming it
		// was clean once. #1825 wired the last two holdouts
		// (`no-unsafe-dictionary-any`, `no-bare-object-param`) in, so this list
		// is empty; a future error-tier rule that skips the wiring reds here
		// instead of silently joining an unaudited gap.
		const selfScanned = new Set(selfScanRuleIds());
		const errorTier = ANTI_SLOP_TIERS.filter(
			([, severity]) => severity === "error",
		).map(([id]) => id);
		const notWired = errorTier.filter((id) => !selfScanned.has(id));
		expect(notWired).toEqual([]);
		expect(selfScanned.has("require-safety-comment-for-as-unknown-as")).toBe(
			true,
		);
		expect(selfScanned.has("no-chained-type-assertions")).toBe(true);
		expect(selfScanned.has("no-unknown-laundering")).toBe(true);
		expect(selfScanned.has("no-unknown-returns")).toBe(true);
	});

	it("no hint-tier anti-slop rule is wired into the self-scan", () => {
		// A hint rule in the self-scan would red CI at opinion density — the
		// exact failure the 2026-08-20 census stopped on for six rules.
		const selfScanned = new Set(selfScanRuleIds());
		const hintTierWired = ANTI_SLOP_TIERS.filter(
			([id, severity]) => severity === "hint" && selfScanned.has(id),
		).map(([id]) => id);
		expect(hintTierWired).toEqual([]);
	});
});

function probeCli(): boolean {
	const result = safeSpawn("ast-grep", ["--version"]);
	return result.status === 0 && !result.error;
}

const cliAvailable = probeCli();
const d = cliAvailable ? describe : describe.skip;

it("ast-grep CLI is installed in CI", () => {
	if (process.env.CI) expect(cliAvailable).toBe(true);
});

/** One uncommented `as unknown as` plus one concrete chain, per file. */
const FIXTURE = [
	"declare const x: A;",
	"type A = { a: number };",
	"type B = { b: number };",
	"type Foo = { foo: number };",
	"export const laundered = x as unknown as Foo;",
	"export const chained = x as A as B;",
	"",
].join("\n");

function scanFixtureTree(): Array<{
	ruleId: string;
	file: string;
	line: number;
}> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-errorfloor-"));
	try {
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
		fs.writeFileSync(path.join(dir, "src", "prod.ts"), FIXTURE, "utf8");
		fs.writeFileSync(path.join(dir, "src", "prod.test.ts"), FIXTURE, "utf8");
		fs.writeFileSync(path.join(dir, "tests", "support.ts"), FIXTURE, "utf8");
		const result = runSelfScan({
			ruleIds: [
				"require-safety-comment-for-as-unknown-as",
				"no-chained-type-assertions",
			],
			scanPaths: [dir],
		});
		return result.findings.map(
			(f: {
				ruleId?: string;
				file?: string;
				range?: { start?: { line?: number } };
			}) => ({
				ruleId: String(f.ruleId),
				file: path.relative(dir, String(f.file)).split(path.sep).join("/"),
				line: (f.range?.start?.line ?? 0) + 1,
			}),
		);
	} finally {
		removeTempDirSync(dir);
	}
}

d("the as-unknown-as pair, on a synthetic tree outside pi-lens (#1727)", () => {
	it("flags the laundering cast in production source", () => {
		const hits = scanFixtureTree().filter(
			(h) => h.ruleId === "require-safety-comment-for-as-unknown-as",
		);
		// Mutation-proof for the scoping: this asserts the rule still FIRES.
		// Widen `ignores:` to swallow production paths and this reds.
		expect(hits.map((h) => h.file)).toEqual(["src/prod.ts"]);
	});

	it("does not flag it in a *.test.ts file or under tests/", () => {
		// Mutation-proof for the scoping the other way: DELETE the `ignores:`
		// block from require-safety-comment-for-as-unknown-as.yml and this reds
		// with src/prod.test.ts and tests/support.ts. That block is what turns
		// a 304-hit rule into a 16-hit one on pi-lens's own tree, which is what
		// made the error promotion possible.
		const files = scanFixtureTree()
			.filter((h) => h.ruleId === "require-safety-comment-for-as-unknown-as")
			.map((h) => h.file);
		expect(files).not.toContain("src/prod.test.ts");
		expect(files).not.toContain("tests/support.ts");
	});

	it("reports each defect once: the two rules partition, never overlap", () => {
		// Before 2026-08-20 both rules matched every `as unknown as` site, so a
		// single cast raised two diagnostics. Re-add the `as unknown as` arm to
		// no-chained-type-assertions.yml and this reds: src/prod.ts:5 comes
		// back under both rule IDs.
		const hits = scanFixtureTree();
		const byLine = new Map<string, string[]>();
		for (const hit of hits) {
			const key = `${hit.file}:${hit.line}`;
			byLine.set(key, [...(byLine.get(key) ?? []), hit.ruleId]);
		}
		// Line 5 is the `as unknown as` cast, line 6 the concrete chain.
		expect(byLine.get("src/prod.ts:5")).toEqual([
			"require-safety-comment-for-as-unknown-as",
		]);
		expect(byLine.get("src/prod.ts:6")).toEqual(["no-chained-type-assertions"]);
		for (const [key, ruleIds] of byLine) {
			expect(ruleIds.length, `${key} reported by ${ruleIds.join(", ")}`).toBe(
				1,
			);
		}
	});
});
