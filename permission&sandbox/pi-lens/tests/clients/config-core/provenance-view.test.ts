import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	isOperatorTier,
	isRepoTier,
	provenanceFor,
	provenanceView,
	SOURCE_TIERS,
	TIER_CLASS,
	tierPrecedence,
} from "../../../clients/config-core/provenance.js";
import { resolveConfig } from "../../../clients/config-core/index.js";
import {
	DEMO_CONFIG_SCHEMA,
	GOLDEN_SOURCES,
} from "../../support/config-core-fixtures.js";

describe("the tier vocabulary is one ordering plus one classification (#2425)", () => {
	it("orders precedence lowest-first with no duplicates", () => {
		const ranks = SOURCE_TIERS.map(tierPrecedence);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(new Set(ranks).size).toBe(SOURCE_TIERS.length);
	});

	it("classifies exactly the two checkout-supplied tiers as repo content", () => {
		expect(SOURCE_TIERS.filter(isRepoTier)).toEqual([
			"project",
			"nested-project",
		]);
		expect(Object.keys(TIER_CLASS).sort()).toEqual([...SOURCE_TIERS].sort());
	});

	it("splits the non-repo tiers into shipped DEFAULTS and operator decisions", () => {
		// #2440 review F3. The two predicates are not complements, and pinning
		// that is the point: `!isRepoTier` used to answer "is this an operator
		// tier", which quietly made every built-in denial permanent.
		expect(SOURCE_TIERS.filter(isOperatorTier)).toEqual([
			"global",
			"env",
			"cli",
			"host",
		]);
		expect(TIER_CLASS.builtin).toBe("default");
		expect(isOperatorTier("builtin")).toBe(false);
		expect(isRepoTier("builtin")).toBe(false);
		expect(new Set(Object.values(TIER_CLASS))).toEqual(
			new Set(["default", "operator", "repo"]),
		);
	});
});

describe("provenanceView is redacted by construction (#2415 AC 4)", () => {
	const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
	const { resolved } = resolveConfig({
		schema: DEMO_CONFIG_SCHEMA,
		sources: [
			...GOLDEN_SOURCES,
			{
				tier: "cli",
				value: {
					lsp: {
						servers: [{ id: "pyright", command: `pyright --token=${secret}` }],
					},
				},
			},
		],
	});

	it("projects sources, never values", () => {
		const view = provenanceView(resolved);
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain(secret);
		// The resolved value DOES carry the command, so the projection is what
		// makes the difference rather than the input being harmless.
		expect(JSON.stringify(resolved.value)).toContain(secret);
	});

	it("names every field it describes and carries only source metadata", () => {
		const view = provenanceView(resolved);
		expect(view.entries.length).toBeGreaterThan(10);
		for (const entry of view.entries) {
			expect(Object.keys(entry).sort()).toEqual(
				expect.arrayContaining(["key", "tier"]),
			);
			expect(
				Object.keys(entry).every((name) =>
					["key", "tier", "file", "trust"].includes(name),
				),
			).toBe(true);
		}
	});

	it("sorts entries by key so two runs render identically", () => {
		const keys = provenanceView(resolved).entries.map((entry) => entry.key);
		expect(keys).toEqual([...keys].sort());
	});
});

describe("a projection never carries the operator's home path (#2440 F5)", () => {
	const home = os.homedir();
	const globalConfig = path.join(home, ".pi-lens", "config.json");

	it("rewrites a $HOME-anchored file to its ~ form", () => {
		const { resolved } = resolveConfig({
			schema: DEMO_CONFIG_SCHEMA,
			sources: [
				{
					tier: "global",
					file: globalConfig,
					value: { lsp: { warmFiles: ["a.ts"] } },
				},
			],
		});
		const view = provenanceView(resolved);
		const serialized = JSON.stringify(view);
		expect(view.entries.length).toBeGreaterThan(0);
		// The absolute path carries the account name; the `~` form carries the
		// same information about WHICH file without it.
		expect(serialized).not.toContain(home);
		expect(serialized).toContain("~/.pi-lens/config.json");
	});

	it("leaves a path outside home alone rather than rewriting every path", () => {
		const { resolved } = resolveConfig({
			schema: DEMO_CONFIG_SCHEMA,
			sources: [
				{
					tier: "project",
					file: ".pi-lens.json",
					value: { lsp: { warmFiles: ["a.ts"] } },
				},
			],
		});
		expect(JSON.stringify(provenanceView(resolved))).toContain(".pi-lens.json");
	});
});

describe("provenanceFor answers at every depth (#2425)", () => {
	const resolved = resolveConfig({
		schema: DEMO_CONFIG_SCHEMA,
		sources: GOLDEN_SOURCES,
	}).resolved;

	it("returns a leaf's own entry when it has one", () => {
		expect(provenanceFor(resolved, "/lsp/servers/0/command")?.tier).toBe(
			"global",
		);
	});

	it("falls back to the nearest ancestor for a replace-merged array member", () => {
		// `warmFiles` is `replace`, so the array carries one entry and its
		// members inherit it. Every element genuinely has the same answer.
		expect(resolved.provenance.has("/lsp/warmFiles/0")).toBe(false);
		expect(provenanceFor(resolved, "/lsp/warmFiles/0")?.tier).toBe("project");
	});

	it("returns undefined for a pointer nothing describes", () => {
		expect(provenanceFor(resolved, "/nothing/here")).toBeUndefined();
	});
});
