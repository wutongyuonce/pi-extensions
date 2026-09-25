/**
 * The config core against input that is trying to break it (#2425, #2440
 * review findings F1, F2 from round 2, and F8, F9 from round 3).
 *
 * F1 and F2 had ONE cause: `normalize.ts` had two arms that handed a user
 * subtree to the domain type with `as ConfigValue` instead of walking it. A
 * subtree that never gets walked never meets the prototype-key policy, is never
 * counted against the depth bound, and never produces a record — so the same
 * assertion produced a prototype hijack, an unbounded recursion in the MERGER
 * (which trusted the validator's output), and silence about both.
 *
 * These suites therefore attack the pipeline through the paths that were
 * un-walked — an opaque schema node, an `additionalProperties: true` node, and
 * an unrecognized `type` keyword — rather than through the paths that always
 * worked.
 *
 * F8 (round 3) found that `merge.ts` still overclaimed: five of its own arms
 * return a contributor's value by reference, unwalked, so the module doc's
 * "merge() enforces the two bounds too" was false for a mixed-shape,
 * opaque-schema node. The fix is the CONTRACT, not a second walk: `merge()`
 * is no longer exported from `index.ts`, and `resolveConfig` — the one
 * supported way in — validates every source before merging. The suite below
 * proves that guarantee directly, using the same mixed-shape gap F8 named, and
 * is sensitive to a mutant that skips validation on any one source.
 *
 * F9 (round 3) found the existing "hostile key introduced by a SECOND tier"
 * test below passed with `merge.ts`'s own `isUnsafeConfigKey` check neutered,
 * because it asserted only the sanitized value, which `safeAssign` backstops
 * regardless of whether that check ran. It is extended to assert the record
 * that only the check itself produces.
 */

import { describe, expect, it } from "vitest";
import {
	CONFIG_DIAGNOSTIC_CODES,
	isConfigDiagnosticCode,
} from "../../../clients/config-diagnostic-codes.js";
import { resolveConfig } from "../../../clients/config-core/index.js";
import { merge } from "../../../clients/config-core/merge.js";
import { validate } from "../../../clients/config-core/normalize.js";
import { provenanceFor } from "../../../clients/config-core/provenance.js";
import { MigrationRecordCollector } from "../../../clients/config-core/records.js";
import {
	MAX_CONFIG_DEPTH,
	UNSAFE_CONFIG_KEYS,
} from "../../../clients/config-core/safe-object.js";
import type { ConfigSchemaNode } from "../../../clients/config-core/schema.js";

/**
 * A key spelled by a PARSER, not by an object literal.
 *
 * `{ __proto__: x }` in source is a prototype directive the engine consumes at
 * construction, so the object never carries the key and the test would prove
 * nothing. `JSON.parse` uses DefineOwnProperty, so it produces a real own
 * enumerable `__proto__` — which is exactly the shape a config FILE produces,
 * and the shape the defect needed.
 */
function parsed(json: string): unknown {
	return JSON.parse(json);
}

/** A schema property that declares nothing at all about its node. */
const OPAQUE_SCHEMA: ConfigSchemaNode = {
	type: "object",
	properties: { diagnostics: { description: "an opaque blob" } },
};

/** A schema property that explicitly opts INTO keeping unknown children. */
const OPEN_SCHEMA: ConfigSchemaNode = {
	type: "object",
	properties: { diagnostics: { type: "object", additionalProperties: true } },
};

/** A schema whose `type` keyword no validator recognizes. */
const UNKNOWN_TYPE_SCHEMA: ConfigSchemaNode = {
	type: "object",
	properties: { diagnostics: { type: "widget" } },
};

const POLLUTION_PATHS: ReadonlyArray<{
	readonly name: string;
	readonly schema: ConfigSchemaNode;
}> = [
	{ name: "an opaque schema node", schema: OPAQUE_SCHEMA },
	{ name: "an additionalProperties:true node", schema: OPEN_SCHEMA },
	{ name: "an unrecognized type keyword", schema: UNKNOWN_TYPE_SCHEMA },
];

describe("no config input can reach an object's prototype (#2440 F1)", () => {
	it("covers every un-walked path the finding named", () => {
		// Declared floor: an emptied matrix must FAIL, not read as clean.
		expect(POLLUTION_PATHS).toHaveLength(3);
	});

	for (const path of POLLUTION_PATHS) {
		it(`refuses __proto__ through ${path.name}, with a record and no hijack`, () => {
			const resolution = resolveConfig({
				schema: path.schema,
				sources: [
					{
						tier: "project",
						file: ".pi-lens.json",
						value: {
							diagnostics: parsed(
								'{"__proto__":{"injected":"pwned","enabled":true},"kept":1}',
							),
						},
					},
				],
			});

			const value = resolution.resolved.value as {
				diagnostics: Record<string, unknown>;
			};
			// The hijack, stated the way it actually presents: the document looks
			// clean when serialized and answers the attacker on a field read.
			expect(JSON.stringify(value)).toBe('{"diagnostics":{"kept":1}}');
			expect(value.diagnostics.injected).toBeUndefined();
			expect(value.diagnostics.enabled).toBeUndefined();
			expect(Object.getPrototypeOf(value.diagnostics)).toBe(Object.prototype);
			// And no OTHER object in the process was re-parented on the way past.
			expect(({} as Record<string, unknown>).injected).toBeUndefined();

			const codes = resolution.records.map((entry) => entry.code);
			expect(codes).toContain("PILENS_CFG_0006");
			for (const code of codes) {
				expect(isConfigDiagnosticCode(code)).toBe(true);
				expect(CONFIG_DIAGNOSTIC_CODES[code]).toBeTruthy();
			}
			const refusal = resolution.records.find(
				(entry) => entry.code === "PILENS_CFG_0006",
			);
			expect(refusal?.key).toBe("/diagnostics/__proto__");
			// Structural only: the record names the key, never the value under it.
			expect(JSON.stringify(resolution.records)).not.toContain("pwned");

			// Every KEPT leaf still carries provenance. A walk that dropped the
			// hostile key but stopped explaining the rest would be a worse fix.
			expect(provenanceFor(resolution.resolved, "/diagnostics/kept")).toEqual({
				tier: "project",
				key: "/diagnostics/kept",
				file: ".pi-lens.json",
			});
			// And nothing is described at a pointer no value can be read from.
			expect([...resolution.resolved.provenance.keys()]).not.toContain(
				"/diagnostics/__proto__",
			);
		});
	}

	it("refuses every key in the unsafe set, not just __proto__", () => {
		expect([...UNSAFE_CONFIG_KEYS].sort()).toEqual([
			"__proto__",
			"constructor",
			"prototype",
		]);
		for (const key of UNSAFE_CONFIG_KEYS) {
			const result = validate(
				{ diagnostics: parsed(`{${JSON.stringify(key)}:{"a":1},"kept":2}`) },
				OPAQUE_SCHEMA,
				{ file: ".pi-lens.json" },
			);
			expect(JSON.stringify(result.value), key).toBe(
				'{"diagnostics":{"kept":2}}',
			);
			expect(
				result.records.some((entry) => entry.code === "PILENS_CFG_0006"),
				key,
			).toBe(true);
		}
	});

	it("refuses a hostile key introduced by a SECOND tier during the merge, and RECORDS it (#2440 F9)", () => {
		// merge.ts had the same `out[name] = …` defect independently of the
		// validator, so it is probed through `merge()` directly — the exported
		// entry point whose input type is a promise rather than a check.
		//
		// The VALUE alone does not prove `mergeObject`'s own `isUnsafeConfigKey`
		// check ran: `safeAssign` backstops the write either way, so a neutered
		// check still leaves the value clean while dropping the explanation
		// (#2440 F9 — this test passed 170/170 with merge.ts:310 commented out
		// before this assertion was added). A collector is passed explicitly
		// because `merge()` without one builds and discards its own.
		const collector = new MigrationRecordCollector();
		const resolved = merge(
			[
				{ tier: "global", value: { diagnostics: { a: 1 } } },
				{
					tier: "project",
					value: parsed(
						'{"diagnostics":{"__proto__":{"injected":"pwned"}}}',
					) as never,
				},
			],
			OPAQUE_SCHEMA,
			{ collector },
		);
		const value = resolved.value as { diagnostics: Record<string, unknown> };
		expect(JSON.stringify(value)).toBe('{"diagnostics":{"a":1}}');
		expect(value.diagnostics.injected).toBeUndefined();
		const refusal = collector.records.find(
			(entry) =>
				entry.code === "PILENS_CFG_0006" &&
				entry.key === "/diagnostics/__proto__",
		);
		expect(refusal).toBeDefined();
		expect([...resolved.provenance.keys()]).not.toContain(
			"/diagnostics/__proto__/injected",
		);
	});

	it("resolveConfig validates every source before merging, even through merge.ts's own leaky arms (#2440 F8)", () => {
		// The gap F8 named: a MIXED-SHAPE node at an opaque schema. `global`
		// contributes an array, `project` a hostile object at the same key.
		// `isObjectNode`/`isArrayNode` both answer "no" for a mixed shape, so
		// `mergeNode` falls through to the leaf arm and returns the winning
		// contribution BY REFERENCE — `mergeObject`'s own `isUnsafeConfigKey`
		// check never runs for it, because that node is never treated as an
		// object at all. The only thing keeping the reference clean is
		// `validate()` having already walked `project`'s source in isolation
		// before `merge()` ever saw it.
		//
		// Mutation-prove: change `index.ts`'s `resolveConfig` to skip `validate`
		// on the second source (e.g. `options.sources.map((source, i) => i === 1
		// ? { ...source, value: source.value } : ...validate...)`) and this goes
		// red — the raw `__proto__` own-property rides through unwalked.
		const resolution = resolveConfig({
			schema: OPAQUE_SCHEMA,
			sources: [
				{ tier: "global", file: "g.json", value: { diagnostics: [] } },
				{
					tier: "project",
					file: "p.json",
					value: {
						diagnostics: parsed('{"__proto__":{"injected":"pwned"},"kept":1}'),
					},
				},
			],
		});
		const value = resolution.resolved.value as {
			diagnostics: Record<string, unknown>;
		};
		expect(
			Object.prototype.hasOwnProperty.call(value.diagnostics, "__proto__"),
		).toBe(false);
		expect(JSON.stringify(value)).toBe('{"diagnostics":{"kept":1}}');
	});
});

describe("no config input can exhaust the stack (#2440 F2)", () => {
	/** Nesting far past both the bound and anything the stack would survive. */
	function nest(levels: number): Record<string, unknown> {
		let value: Record<string, unknown> = { leaf: true };
		for (let level = 0; level < levels; level += 1) value = { nest: value };
		return value;
	}

	const DEEP_SCHEMA: ConfigSchemaNode = {
		type: "object",
		properties: { blob: { description: "an opaque blob" } },
	};

	it("bounds an opaque subtree at MAX_CONFIG_DEPTH and records the truncation", () => {
		const result = validate({ blob: nest(4000) }, DEEP_SCHEMA, {
			file: ".pi-lens.json",
		});
		const truncations = result.records.filter((entry) =>
			entry.reason.includes("nesting exceeds"),
		);
		expect(truncations.length).toBeGreaterThan(0);
		expect(truncations[0].code).toBe("PILENS_CFG_0005");
		expect(depthOf(result.value)).toBeLessThanOrEqual(MAX_CONFIG_DEPTH + 1);
	});

	it("resolves a 4000-deep config instead of throwing a RangeError", () => {
		// The finding's own probe: two tiers, so the merger recurses over both.
		const resolution = resolveConfig({
			schema: DEEP_SCHEMA,
			sources: [
				{ tier: "global", file: "g.json", value: { blob: nest(4000) } },
				{ tier: "project", file: "p.json", value: { blob: nest(4000) } },
			],
		});
		expect(resolution.records.length).toBeGreaterThan(0);
		expect(depthOf(resolution.resolved.value)).toBeLessThanOrEqual(
			MAX_CONFIG_DEPTH + 1,
		);
	});

	it("bounds the MERGER too, for a value that never met the validator", () => {
		// `merge()` is exported and its input type only PROMISES normalized
		// values. A caller that merges a hand-built value must still not recurse
		// without bound, so the merger counts its own depth.
		expect(() =>
			merge(
				[
					{ tier: "global", value: { blob: nest(4000) } as never },
					{ tier: "project", value: { blob: nest(4000) } as never },
				],
				{ type: "object", properties: { blob: {} } },
			),
		).not.toThrow();
	});
});

describe("resolveConfig never throws, whatever it is handed (#2440 F2)", () => {
	/**
	 * A deterministic PRNG. A fuzz suite that reseeded per run would report a
	 * different failure on every CI attempt and could not be bisected; seeding it
	 * makes the 200 shapes below the same 200 shapes on every machine.
	 */
	function makeRandom(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 0x100000000;
		};
	}

	function hostileValue(random: () => number, depth: number): unknown {
		const roll = Math.floor(random() * 10);
		if (depth > 6 || roll < 3) {
			return [
				null,
				0,
				-1,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				"",
				"__proto__",
				true,
			][Math.floor(random() * 8)];
		}
		if (roll < 5) {
			return Array.from({ length: Math.floor(random() * 4) }, () =>
				hostileValue(random, depth + 1),
			);
		}
		const keys = [
			"__proto__",
			"constructor",
			"prototype",
			"lsp",
			"enabled",
			"",
			"toString",
		];
		const entries: string[] = [];
		for (let index = 0; index < Math.floor(random() * 4) + 1; index += 1) {
			const key = keys[Math.floor(random() * keys.length)];
			entries.push(
				`${JSON.stringify(key)}:${JSON.stringify(
					hostileValue(random, depth + 1),
				)}`,
			);
		}
		// Round-tripped through the parser so hostile keys are real own
		// properties, exactly as they arrive from a file.
		return parsed(`{${entries.join(",")}}`);
	}

	it("survives 200 hostile shapes without throwing or polluting", () => {
		const random = makeRandom(20_250_902);
		const schemas = [
			OPAQUE_SCHEMA,
			OPEN_SCHEMA,
			UNKNOWN_TYPE_SCHEMA,
			{ type: "object", properties: { diagnostics: { type: "string" } } },
			{ type: "object" },
		] as const;
		let resolutions = 0;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const schema = schemas[attempt % schemas.length];
			const value = hostileValue(random, 0);
			expect(() => {
				const resolution = resolveConfig({
					schema,
					sources: [
						{ tier: "global", file: "g.json", value },
						{ tier: "project", file: "p.json", value },
					],
				});
				// The resolved document must still be plain JSON data.
				JSON.stringify(resolution.resolved.value);
				resolutions += 1;
			}, `attempt ${attempt}`).not.toThrow();
		}
		// Declared floor: a loop that silently ran zero resolutions would
		// otherwise pass as clean (AGENTS.md vacuous-skip shape).
		expect(resolutions).toBe(200);
		expect(({} as Record<string, unknown>).injected).toBeUndefined();
		expect(({} as Record<string, unknown>).lsp).toBeUndefined();
	});
});

/** Nesting depth of a resolved value, for asserting the bound held. */
function depthOf(value: unknown): number {
	if (Array.isArray(value)) {
		return 1 + Math.max(0, ...value.map(depthOf));
	}
	if (typeof value === "object" && value !== null) {
		const children = Object.values(value as Record<string, unknown>);
		return 1 + Math.max(0, ...children.map(depthOf));
	}
	return 0;
}
