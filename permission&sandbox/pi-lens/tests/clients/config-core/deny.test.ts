import { describe, expect, it } from "vitest";
import {
	resolveArrayDeny,
	resolveBooleanDeny,
} from "../../../clients/config-core/deny.js";
import {
	type ConfigSource,
	merge,
} from "../../../clients/config-core/merge.js";
import { SOURCE_TIERS } from "../../../clients/config-core/provenance.js";
import type { ConfigValue } from "../../../clients/config-core/schema.js";
import { DENY_ONLY_SCHEMA } from "../../support/config-core-fixtures.js";

/** The whole resolution as one comparable string, provenance included. */
function fingerprint(sources: readonly ConfigSource[]): string {
	const resolved = merge(sources, DENY_ONLY_SCHEMA);
	return JSON.stringify({
		value: resolved.value,
		provenance: [...resolved.provenance.entries()].sort(),
	});
}

const OPERATOR_DENY: ConfigSource = {
	tier: "global",
	file: "~/.pi-lens/config.json",
	value: { enabled: false, blocked: ["gopls"] },
};

/**
 * #2415 AC 3. Every field a repository could write to weaken the operator's
 * denial, tried one at a time and together. The bar is BYTE-IDENTICAL: not
 * "still disabled", but the same resolved document and the same provenance, so
 * a partial weakening that merely looked denied would still fail.
 */
const WEAKENING_MUTATIONS: ReadonlyArray<{
	readonly name: string;
	readonly value: ConfigValue;
	readonly tier: "project" | "nested-project";
}> = [
	{
		name: "project sets enabled true",
		value: { enabled: true },
		tier: "project",
	},
	{
		name: "project empties the deny list",
		value: { blocked: [] },
		tier: "project",
	},
	{
		name: "project does both at once",
		value: { enabled: true, blocked: [] },
		tier: "project",
	},
	{
		name: "nested project sets enabled true",
		value: { enabled: true },
		tier: "nested-project",
	},
	{
		name: "nested project empties the deny list",
		value: { blocked: [] },
		tier: "nested-project",
	},
	{
		name: "nested project does both at once",
		value: { enabled: true, blocked: [] },
		tier: "nested-project",
	},
];

describe("monotonic deny: repo config cannot weaken an operator denial (#2425)", () => {
	const baseline = fingerprint([OPERATOR_DENY]);

	it("resolves the operator denial in the first place", () => {
		expect(JSON.parse(baseline).value).toEqual({
			enabled: false,
			blocked: ["gopls"],
		});
	});

	it("covers every tier the mutation matrix claims to", () => {
		// Declared floor: an emptied matrix must FAIL, not read as clean.
		expect(WEAKENING_MUTATIONS.length).toBeGreaterThanOrEqual(6);
		expect(new Set(WEAKENING_MUTATIONS.map((m) => m.tier))).toEqual(
			new Set(["project", "nested-project"]),
		);
	});

	for (const mutation of WEAKENING_MUTATIONS) {
		it(`is byte-identical when the ${mutation.name}`, () => {
			const mutated = fingerprint([
				OPERATOR_DENY,
				{
					tier: mutation.tier,
					file: ".pi-lens.json",
					trust: "trusted",
					value: mutation.value,
				},
			]);
			expect(mutated).toBe(baseline);
		});
	}

	it("lets a repo tier ADD a denial while still not removing one", () => {
		// Monotonic means one-directional, not frozen: a project may deny more.
		const resolved = merge(
			[
				OPERATOR_DENY,
				{ tier: "project", value: { blocked: ["rust-analyzer"] } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({
			enabled: false,
			blocked: ["gopls", "rust-analyzer"],
		});
	});

	it("keeps the denial even when the repo config is TRUSTED", () => {
		// Trust decides whether a repo command may SPAWN. It never decides
		// whether a repo file may re-enable what the operator switched off.
		const trusted = fingerprint([
			OPERATOR_DENY,
			{
				tier: "project",
				file: ".pi-lens.json",
				trust: "trusted",
				value: { enabled: true, blocked: [] },
			},
		]);
		expect(trusted).toBe(baseline);
	});

	it("attributes the denial to the tier that made it, not the last tier to see it", () => {
		const resolved = merge(
			[
				OPERATOR_DENY,
				{ tier: "project", value: { enabled: true } },
				{ tier: "nested-project", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.provenance.get("/enabled")).toEqual({
			tier: "global",
			key: "/enabled",
			file: "~/.pi-lens/config.json",
		});
	});
});

describe("monotonic deny: the one legitimate lift (#2425)", () => {
	it("lets an operator tier ABOVE a repo denial re-enable it", () => {
		const resolved = merge(
			[
				{ tier: "project", value: { enabled: false } },
				{ tier: "cli", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: true });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("cli");
	});

	it("does NOT let another repo tier re-enable a repo denial", () => {
		const resolved = merge(
			[
				{ tier: "project", value: { enabled: false } },
				{ tier: "nested-project", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: false });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("project");
	});

	it("does NOT let a built-in DEFAULT re-enable a repo denial", () => {
		// A built-in default saying `true` is the absence of an opinion, not an
		// operator overriding a repository — and it is not an operator tier at
		// all, so it cannot lift anything.
		const resolved = merge(
			[
				{ tier: "builtin", value: { enabled: true } },
				{ tier: "project", value: { enabled: false } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: false });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("project");
	});

	it("never lets any tier lift an OPERATOR denial", () => {
		for (const tier of SOURCE_TIERS) {
			const resolved = merge(
				[
					{ tier: "global", value: { enabled: false } },
					{ tier, value: { enabled: true } },
				],
				DENY_ONLY_SCHEMA,
			);
			expect(resolved.value, tier).toEqual({ enabled: false });
		}
	});

	it("does not let a nearer OPERATOR tier lift an operator denial either", () => {
		// The spec letter, kept deliberately (#2440 review F3, docs section 5):
		// `cli: true` does not out-rank `global: false`. The escape hatch for an
		// operator who changed their mind is the operator-tier config that denied,
		// not a second operator tier shouting over it.
		const resolved = merge(
			[
				{ tier: "global", value: { enabled: false } },
				{ tier: "cli", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: false });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("global");
	});
});

/**
 * #2440 review finding F3. `builtin` used to sit in the operator class, so a
 * denial pi-lens SHIPPED was unliftable by everyone including the person who
 * installed pi-lens. The third class makes a shipped default a default again
 * without letting repository content near the decision.
 */
describe("a built-in denial is a DEFAULT, not an operator decision (#2425)", () => {
	it("lets the operator's own global config lift a built-in denial", () => {
		const resolved = merge(
			[
				{ tier: "builtin", value: { enabled: false } },
				{
					tier: "global",
					file: "~/.pi-lens/config.json",
					value: { enabled: true },
				},
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: true });
		expect(resolved.provenance.get("/enabled")).toEqual({
			tier: "global",
			key: "/enabled",
			file: "~/.pi-lens/config.json",
		});
	});

	it("lets every operator tier lift a built-in denial", () => {
		for (const tier of ["global", "env", "cli", "host"] as const) {
			const resolved = merge(
				[
					{ tier: "builtin", value: { enabled: false } },
					{ tier, value: { enabled: true } },
				],
				DENY_ONLY_SCHEMA,
			);
			expect(resolved.value, tier).toEqual({ enabled: true });
			expect(resolved.provenance.get("/enabled")?.tier, tier).toBe(tier);
		}
	});

	it("does NOT let a repo tier lift a built-in denial", () => {
		for (const tier of ["project", "nested-project"] as const) {
			const resolved = merge(
				[
					{ tier: "builtin", value: { enabled: false } },
					{
						tier,
						file: ".pi-lens.json",
						trust: "trusted",
						value: { enabled: true },
					},
				],
				DENY_ONLY_SCHEMA,
			);
			expect(resolved.value, tier).toEqual({ enabled: false });
			// Attributed to the tier that DENIED, which is the answer to "why can
			// I not turn this back on".
			expect(resolved.provenance.get("/enabled")?.tier, tier).toBe("builtin");
		}
	});

	it("keeps the repo tier out even when an operator tier ranks below the denial", () => {
		// builtin:false + project:true, with nothing above project to lift it.
		const resolved = merge(
			[
				{ tier: "builtin", value: { enabled: false } },
				{ tier: "project", value: { enabled: true } },
				{ tier: "nested-project", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: false });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("builtin");
	});
});

describe("array-union denials accumulate and never shrink (#2425)", () => {
	it("unions members across tiers, lowest precedence first", () => {
		const resolved = merge(
			[
				{ tier: "builtin", value: { blocked: ["a"] } },
				{ tier: "global", value: { blocked: ["b", "a"] } },
				{ tier: "project", value: { blocked: ["c"] } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ blocked: ["a", "b", "c"] });
		expect(resolved.provenance.get("/blocked")?.tier).toBe("builtin");
	});

	it("beats the node's own replace strategy, which would have erased a member", () => {
		// `blocked` declares no strategy, so it defaults to `replace`. The deny
		// annotation is what stops the nearer tier's shorter list from winning.
		const resolved = merge(
			[
				{ tier: "global", value: { blocked: ["gopls"] } },
				{ tier: "project", value: { blocked: ["rust-analyzer"] } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ blocked: ["gopls", "rust-analyzer"] });
	});
});

describe("deny resolvers in isolation (#2425)", () => {
	it("falls through to last-wins when nothing denies", () => {
		expect(
			resolveBooleanDeny([
				{ tier: "global", value: true },
				{ tier: "project", value: true },
			]),
		).toEqual({ value: true, winner: 1, denied: false, memberWinners: [] });
	});

	it("reports no winner for an empty contribution list", () => {
		expect(resolveBooleanDeny([])).toEqual({
			value: undefined,
			winner: -1,
			denied: false,
			// A boolean deny has no members, so the per-member attribution added
			// for #2427 review round 2 F2 is empty rather than absent.
			memberWinners: [],
		});
	});

	it("ignores non-array contributions to a union list", () => {
		expect(
			resolveArrayDeny([
				{ tier: "global", value: "not-a-list" },
				{ tier: "project", value: ["x"] },
			]),
			// `memberWinners` is positionally parallel to `value`: the one surviving
			// member came from contribution 1, the non-array contribution nothing.
		).toEqual({
			value: ["x"],
			winner: 1,
			denied: true,
			memberWinners: [1],
		});
	});

	it("attributes each surviving union member to the tier that contributed it", () => {
		const resolution = resolveArrayDeny([
			{ tier: "global", value: ["typos"] },
			{ tier: "project", value: ["marksman"] },
		]);
		expect(resolution.value).toEqual(["typos", "marksman"]);
		// Positionally parallel: member 0 came from the global contribution,
		// member 1 from the project one. `winner` alone says 0 for both, which is
		// what reported a project denial as a global one (round 2, F2).
		expect(resolution.memberWinners).toEqual([0, 1]);
		expect(resolution.winner).toBe(0);
	});

	it("keeps structurally equal object members rather than folding them", () => {
		const resolution = resolveArrayDeny([
			{ tier: "global", value: [{ id: "x" }] },
			{ tier: "project", value: [{ id: "x" }] },
		]);
		expect(resolution.value).toEqual([{ id: "x" }, { id: "x" }]);
	});
});
