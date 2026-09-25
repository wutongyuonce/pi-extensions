// #3053: `buildEffectiveAstGrepCatalog` is the single derivation the NAPI
// runner (clients/dispatch/runners/ast-grep-napi.ts) and the LSP-seam matcher
// (clients/dispatch/rule-ignores.ts) both now read, replacing two copies that
// had already drifted once (#3046 round 2 F1: a project rule redefining a
// bundled id with no `ignores` claimed the id per-edit but not over LSP).
// These cases pin the catalog's own precedence and within-source-duplicate
// decisions directly, at the seam both consumers now share, so a future
// change to the catalog can't silently re-open that drift for one consumer
// while the other's own tests stay green.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEffectiveAstGrepCatalog } from "../../../clients/dispatch/ast-grep-catalog.js";
import { removeTempDirSync } from "../test-utils.js";

const PRIMARY_RULES = path.join("rules", "ast-grep-rules", "rules");

function makeProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ast-grep-catalog-"));
}

function writeRule(
	root: string,
	relDir: string,
	fileName: string,
	body: { id: string; ignores?: readonly string[]; message?: string },
): void {
	const dir = path.join(root, relDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, fileName),
		[
			`id: ${body.id}`,
			`message: ${JSON.stringify(body.message ?? body.id)}`,
			...(body.ignores
				? [
						"ignores:",
						...body.ignores.map((glob) => `  - ${JSON.stringify(glob)}`),
					]
				: []),
			"rule:",
			"  pattern: dummy($A)",
			"",
		].join("\n"),
	);
}

describe("buildEffectiveAstGrepCatalog (#3053)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) removeTempDirSync(root);
	});

	it("a project rule claims a bundled id, and its own ignores win — not the bundled copy's", () => {
		const root = makeProject();
		roots.push(root);
		// Redefine a real bundled id so the precedence collision is against the
		// production catalog, not a fixture id that could never collide.
		writeRule(root, PRIMARY_RULES, "override.yml", {
			id: "no-console-except-error",
			ignores: ["vendor/**"],
		});

		const catalog = buildEffectiveAstGrepCatalog(root);
		const entry = catalog.effectiveRules.get("no-console-except-error");
		expect(entry?.source.origin).toBe("project");
		expect(entry?.rule.ignores).toEqual(["vendor/**"]);
	});

	it("claims the first-sighted document for an id duplicated within one source, rather than dropping it", () => {
		// Guards #3046 round 2 F7's decision: the runner drops a within-source
		// duplicate id entirely (its own `duplicateRuleIds` skip, layered on top
		// of this catalog), but ast-grep's own LSP still publishes both
		// documents' findings (`materializeMergedRuleDir` keeps every document an
		// EARLIER source hasn't claimed, and both copies here are the SAME
		// source). If this catalog also dropped the id, the LSP seam would
		// register no `ignores` for it at all and those published findings would
		// go unfiltered — reopening #3041 for that id. Sort ordinal-first so the
		// production loader (`compareOrdinal` file order) picks this one first.
		const root = makeProject();
		roots.push(root);
		writeRule(root, PRIMARY_RULES, "a-first.yml", {
			id: "duplicate-in-one-source",
			message: "first, no ignores",
		});
		writeRule(root, PRIMARY_RULES, "b-second.yml", {
			id: "duplicate-in-one-source",
			ignores: ["never-registered/**"],
			message: "second, has ignores",
		});

		const catalog = buildEffectiveAstGrepCatalog(root);
		const entry = catalog.effectiveRules.get("duplicate-in-one-source");
		expect(entry?.rule.message).toBe("first, no ignores");
		expect(entry?.rule.ignores).toBeUndefined();
	});

	it("walks sources in project-then-bundled precedence order", () => {
		// #3053 round 2 F2: with only one project source present, `indexOf` and
		// `lastIndexOf` degenerate the same way `getAstGrepRuleSources`'s own
		// reversed order would — `indexOf("bundled")` was 0 either way, so
		// `slice(0, 0).every(...)` was vacuously true and stayed green under
		// `candidates.reverse()`. `lastIndexOf("project") < indexOf("bundled")`
		// plus pinning the array's own first element both require the REAL
		// (non-reversed) order to hold.
		const root = makeProject();
		roots.push(root);
		writeRule(root, PRIMARY_RULES, "own.yml", { id: "project-only-rule" });
		const catalog = buildEffectiveAstGrepCatalog(root);
		const origins = catalog.sources.map((s) => s.source.origin);
		expect(origins[0]).toBe("project");
		expect(origins.lastIndexOf("project")).toBeLessThan(
			origins.indexOf("bundled"),
		);
	});
});
