/**
 * #2089 — a test that cannot run must SKIP, never bare-`return`.
 *
 * Vitest reports a body that returns early as PASSED. `pnpm-symlink.test.ts`
 * spent months reporting green on ubuntu-latest CI while asserting nothing at
 * all, and `tree-sitter-client-init.test.ts` passed on exactly the failure it
 * was written to catch. AGENTS.md test-authoring screen 2 states the rule; this
 * sweep enforces it mechanically over the whole `tests/` tree.
 *
 * See tests/support/vacuous-skip-scan.ts for the detector's mechanics and its
 * declared blind spots.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan, auditRegistry } from "../support/sweep-kit.js";
import {
	listTestFiles,
	repoRoot,
	scanVacuousSkips,
	scanVacuousSkipsInSource,
	vacuousSkipKey,
} from "../support/vacuous-skip-scan.js";

/**
 * Reviewed exceptions, keyed `<file>:<test name>`, each with the reason the
 * bare return is right there. Empty on purpose: #2089 converted all thirteen
 * live sites to `it.skipIf` or `ctx.skip(reason)`, and no shape has yet turned
 * up that neither can express. `auditRegistry` reports an entry the scan stops
 * flagging, so an exemption cannot outlive the site it excuses.
 */
const REVIEWED_EXCEPTIONS: Readonly<Record<string, string>> = {};

/**
 * Self-exclusion. The fixtures below are STRINGS, and the detector blanks
 * string contents before it reads anything, so this file cannot flag itself
 * today. The offending token is still split and re-joined at runtime: the
 * string policy is a detector option, and a future author who flips it must not
 * discover the flip by watching this guard indict its own fixtures.
 */
const BARE_RETURN = "ret" + "urn;";

interface Fixture {
	name: string;
	source: string;
}

/** Shapes the detector MUST catch. */
const CAUGHT: readonly Fixture[] = [
	{
		name: "a platform gate that returns before the first assertion",
		source: [
			'it("is case-insensitive on win32", () => {',
			`\tif (process.platform !== "win32") ${BARE_RETURN}`,
			'\texpect(fold("A")).toBe("a");',
			"});",
		].join("\n"),
	},
	{
		name: "a bare return in a catch, with no skip call",
		source: [
			'it("resolves the package", () => {',
			"\tlet resolved;",
			"\ttry {",
			'\t\tresolved = require.resolve("pkg");',
			"\t} catch {",
			`\t\t${BARE_RETURN}`,
			"\t}",
			"\texpect(resolved).toBeTruthy();",
			"});",
		].join("\n"),
	},
	{
		name: "a gated body nested inside a declarative skipIf wrapper",
		source: [
			'it.skipIf(!enabled)("still gated a second time", () => {',
			`\tif (process.platform !== "win32") ${BARE_RETURN}`,
			"\texpect(1).toBe(1);",
			"});",
		].join("\n"),
	},
	{
		name: "a gated body inside an it.each table",
		source: [
			'it.each([["a"], ["b"]])("case %s", (value) => {',
			`\tif (!value) ${BARE_RETURN}`,
			"\texpect(value).toBeTruthy();",
			"});",
		].join("\n"),
	},
	{
		name: "test() rather than it()",
		source: [
			'test("aliased declaration form", async () => {',
			`\tif (!ready) ${BARE_RETURN}`,
			"\tawait expect(run()).resolves.toBe(1);",
			"});",
		].join("\n"),
	},
];

/** Shapes the detector must NOT flag. */
const CLEARED: readonly Fixture[] = [
	{
		name: "ctx.skip() before the return",
		source: [
			'it("skips visibly", (ctx) => {',
			"\tif (!alias) {",
			"\t\tctx.skip();",
			`\t\t${BARE_RETURN}`,
			"\t}",
			"\texpect(alias).toBeTruthy();",
			"});",
		].join("\n"),
	},
	{
		name: "a destructured skip(reason) before the return",
		source: [
			'it("skips with a reason", ({ skip }) => {',
			"\ttry {",
			"\t\tlink();",
			"\t} catch (err) {",
			"\t\tskip(`symlink setup unavailable: ${err}`);",
			`\t\t${BARE_RETURN}`,
			"\t}",
			"\texpect(link).toBeTruthy();",
			"});",
		].join("\n"),
	},
	{
		name: "an assertion before the return",
		source: [
			'it("asserts, then bails on the rest", () => {',
			'\texpect(path.sep).toBe("/");',
			`\tif (path.sep !== "\\\\") ${BARE_RETURN}`,
			"\texpect(more()).toBe(1);",
			"});",
		].join("\n"),
	},
	{
		name: "a return inside a nested callback",
		source: [
			'it("filters entries", () => {',
			"\tconst kept = items.filter((x) => {",
			`\t\tif (!x.ok) ${BARE_RETURN}`,
			"\t\treturn true;",
			"\t});",
			"\texpect(kept).toHaveLength(1);",
			"});",
		].join("\n"),
	},
	{
		name: "a return inside a beforeAll hook",
		source: [
			"beforeAll(() => {",
			`\tif (cached) ${BARE_RETURN}`,
			"\tbuild();",
			"});",
		].join("\n"),
	},
	{
		name: "a module-level helper that returns early",
		source: [
			"function findGate(source) {",
			`\tif (!source) ${BARE_RETURN}`,
			"\treturn source.gate;",
			"}",
		].join("\n"),
	},
	{
		name: "the declarative spelling this guard pushes people toward",
		source: [
			'it.skipIf(process.platform !== "win32")("win32 casing", () => {',
			'\texpect(fold("A")).toBe("a");',
			"});",
		].join("\n"),
	},
	{
		name: "a fixture STRING whose body is a bare return",
		source: [
			'it("matches noreturn-returns when return is present", async () => {',
			"\tconst file = writeTempCFile(`",
			"void fatal() {",
			`    ${BARE_RETURN}`,
			"}",
			"`);",
			"\texpect(await run(file)).toHaveLength(1);",
			"});",
		].join("\n"),
	},
];

describe("tests skip visibly instead of returning early (#2089)", () => {
	it("no test body returns before it asserts or skips", () => {
		const scannedCount = listTestFiles().length;
		// Calibration: 786 test files walked on 2026-08-25; half is 393, rounded
		// down to the documented 390 floor.
		assertNonEmptyScan("vacuous-skip file walk", scannedCount, 390);

		const findings = scanVacuousSkips();
		const audit = auditRegistry({
			sweepName: "vacuous-skip sweep",
			flagged: findings.map(vacuousSkipKey),
			registered: [],
			exemptions: REVIEWED_EXCEPTIONS,
			minReasonLength: 20,
			scannedCount,
			minScanned: 390,
			// A ZERO-flag census is the healthy state here, unlike every other
			// sweep in this repo: the population it counts is defects, not
			// surfaces, and #2089 emptied it. The detector's liveness is proved by
			// the two-direction probe below instead — a floor of 1 here would only
			// force a defect to be kept alive to satisfy it.
			minFlagged: 0,
			remediation:
				"Use it.skipIf(cond)(...) with a stated reason, or call ctx.skip(reason) " +
				"before the return. A bare return reports as PASSED and claims coverage " +
				"the run never had (AGENTS.md test-authoring screen 2).",
		});
		// The line numbers first, because that is what an author needs to act;
		// `audit.problems` then covers the floors and the exemption bookkeeping the
		// list alone cannot express.
		const unaccounted = findings
			.filter((entry) => audit.unaccounted.includes(vacuousSkipKey(entry)))
			.map((entry) => `${entry.file}:${entry.line} — ${entry.testName}`);
		expect(unaccounted, "test bodies that return before asserting").toEqual([]);
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});

	it("catches the shapes it claims to catch", () => {
		const missed = CAUGHT.filter(
			(fixture) =>
				scanVacuousSkipsInSource("fixture.test.ts", fixture.source).length ===
				0,
		).map((fixture) => fixture.name);
		expect(missed, "these evaded the detector").toEqual([]);
	});

	it("clears the shapes that are not this defect", () => {
		const misfired = CLEARED.filter(
			(fixture) =>
				scanVacuousSkipsInSource("fixture.test.ts", fixture.source).length > 0,
		).map((fixture) => fixture.name);
		expect(misfired, "these were flagged and should not have been").toEqual([]);
	});

	// The fixture probes above run on synthetic source. This one runs on the
	// file the ORIGINAL census called the correct pattern: four skip-first
	// returns, all cleared. Deleting the `ctx.skip()` calls must flag all four —
	// otherwise "clean" here would mean the walk never reached the file.
	it("reads the compliant sites as compliant BECAUSE of the skip call", () => {
		const file = "tests/clients/dispatch/runners/helm-render.test.ts";
		const raw = fs.readFileSync(path.join(repoRoot, file), "utf8");
		expect(scanVacuousSkipsInSource(file, raw)).toEqual([]);

		const withoutSkips = raw.replaceAll("ctx.skip();", "");
		expect(raw).not.toBe(withoutSkips);
		expect(
			scanVacuousSkipsInSource(file, withoutSkips).length,
			"removing the skip calls must expose the returns they excuse",
		).toBeGreaterThanOrEqual(4);
	});

	// The string-blanking defense, on the real file that needs it: a C fixture
	// whose function body IS `return;` (tree-sitter-c-rules.test.ts:65).
	it("does not read a fixture string as the test's own control flow", () => {
		const file = "tests/clients/tree-sitter-c-rules.test.ts";
		const raw = fs.readFileSync(path.join(repoRoot, file), "utf8");
		expect(raw, "the C fixture this case exists for has moved").toContain(
			BARE_RETURN,
		);
		expect(scanVacuousSkipsInSource(file, raw)).toEqual([]);
	});
});
