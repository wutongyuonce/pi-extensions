import { describe, expect, it } from "vitest";
import {
	CONFIG_SCHEMA_ANCHOR_KEY,
	CONFIG_SCHEMA_ID,
	STABILITY_TIER_KEY,
} from "../../clients/config-diagnostic-codes.js";
import {
	assertSchemaIdentityAnchor,
	assertSchemaStabilityTiers,
	type JsonSchemaNode,
	PLACEHOLDER_CONFIG_SCHEMA,
} from "../support/schema-stability.js";

/**
 * #2418 policy point 1 + 3, enforced as a harness rather than against a
 * schema that does not exist yet. #2416 ships the first real catalog schema
 * and asserts it with these same two functions; if the harness itself is
 * inert, that drift test is inert too — so the mutants below are the load
 * bearing half of this file.
 */

function clone(schema: JsonSchemaNode): JsonSchemaNode {
	return structuredClone(schema);
}

describe("schema stability tiers (#2418)", () => {
	it("accepts a schema whose every property carries a valid tier", () => {
		expect(() =>
			assertSchemaStabilityTiers(PLACEHOLDER_CONFIG_SCHEMA),
		).not.toThrow();
	});

	it("fails a top-level property with no tier", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		delete properties.lsp[STABILITY_TIER_KEY];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
			/missing x-stability/,
		);
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(/\/lsp/);
	});

	it("fails a NESTED property with no tier", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		const servers = (
			properties.lsp.properties as Record<string, JsonSchemaNode>
		).servers;
		delete servers[STABILITY_TIER_KEY];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(/\/lsp\/servers/);
	});

	it("fails a property reached only through items[]", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		const servers = (
			properties.lsp.properties as Record<string, JsonSchemaNode>
		).servers;
		const items = servers.items as JsonSchemaNode;
		delete (items.properties as Record<string, JsonSchemaNode>).id[
			STABILITY_TIER_KEY
		];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
			/\/lsp\/servers\/items\/id/,
		);
	});

	it("fails an unknown tier value", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		properties.lsp[STABILITY_TIER_KEY] = "beta";
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
			/invalid x-stability/,
		);
	});

	it("accepts both tiers in the closed vocabulary", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		properties.lsp[STABILITY_TIER_KEY] = "stable";
		expect(() => assertSchemaStabilityTiers(mutant)).not.toThrow();
	});
});

/**
 * #2418 review, F2. The first walker knew only `properties` and `items`, so an
 * untiered field anywhere else — a `oneOf` branch, a `$defs` block, a
 * `patternProperties` map — passed the tier gate silently. A drift test that
 * cannot see the shapes a real JSON Schema uses is not a weak test, it is a
 * test that reads as coverage while providing none, which is worse.
 *
 * Every case below is a MUTANT: the same subschema is asserted twice, once
 * with the tier and once without, so each keyword proves both directions. The
 * negative half is what goes red on the pre-fix walker.
 */

/** A property-bearing subschema whose single field may or may not be tiered. */
function withHidden(tier?: string): JsonSchemaNode {
	return {
		type: "object",
		properties: {
			hidden: tier
				? { type: "string", [STABILITY_TIER_KEY]: tier }
				: { type: "string" },
		},
	};
}

/** The minimal valid envelope, with `lsp` extended by one composition keyword. */
function envelopeWith(node: JsonSchemaNode): JsonSchemaNode {
	const schema = clone(PLACEHOLDER_CONFIG_SCHEMA);
	const properties = schema.properties as Record<string, JsonSchemaNode>;
	properties.lsp = {
		type: "object",
		[STABILITY_TIER_KEY]: "experimental",
		...node,
	};
	return schema;
}

const COMPOSITION_CASES: ReadonlyArray<{
	readonly keyword: string;
	readonly build: (tier?: string) => JsonSchemaNode;
	readonly pointer: string;
}> = [
	{
		keyword: "oneOf",
		build: (tier) => ({ oneOf: [withHidden(tier)] }),
		pointer: "/lsp/oneOf/0/hidden",
	},
	{
		keyword: "anyOf",
		build: (tier) => ({ anyOf: [withHidden(tier)] }),
		pointer: "/lsp/anyOf/0/hidden",
	},
	{
		keyword: "allOf",
		build: (tier) => ({ allOf: [withHidden(tier)] }),
		pointer: "/lsp/allOf/0/hidden",
	},
	{
		keyword: "prefixItems",
		build: (tier) => ({ prefixItems: [withHidden(tier)] }),
		pointer: "/lsp/prefixItems/0/hidden",
	},
	{
		keyword: "$defs",
		build: (tier) => ({ $defs: { serverSpec: withHidden(tier) } }),
		pointer: "/lsp/$defs/serverSpec/hidden",
	},
	{
		keyword: "definitions",
		build: (tier) => ({ definitions: { serverSpec: withHidden(tier) } }),
		pointer: "/lsp/definitions/serverSpec/hidden",
	},
	{
		keyword: "additionalProperties",
		build: (tier) => ({ additionalProperties: withHidden(tier) }),
		pointer: "/lsp/additionalProperties/hidden",
	},
	{
		keyword: "not",
		build: (tier) => ({ not: withHidden(tier) }),
		pointer: "/lsp/not/hidden",
	},
	{
		keyword: "if",
		build: (tier) => ({ if: withHidden(tier), then: { type: "object" } }),
		pointer: "/lsp/if/hidden",
	},
	{
		keyword: "then",
		build: (tier) => ({ if: { type: "object" }, then: withHidden(tier) }),
		pointer: "/lsp/then/hidden",
	},
	{
		keyword: "else",
		build: (tier) => ({ if: { type: "object" }, else: withHidden(tier) }),
		pointer: "/lsp/else/hidden",
	},
	{
		keyword: "patternProperties",
		build: (tier) => ({
			patternProperties: {
				"^ext-": tier
					? { type: "string", [STABILITY_TIER_KEY]: tier }
					: { type: "string" },
			},
		}),
		pointer: "/lsp/^ext-",
	},
	{
		// 2020-12 conditional-shape keyword: the subschema applied when a
		// property is present. Named subschemas, not properties themselves —
		// but every field inside one is as published as any other.
		keyword: "dependentSchemas",
		build: (tier) => ({ dependentSchemas: { servers: withHidden(tier) } }),
		pointer: "/lsp/dependentSchemas/servers/hidden",
	},
	{
		// draft-07 spelling of the same thing. Schemas in the wild are still
		// written against draft-07, and #2416 will consume whichever the
		// catalog author reaches for.
		keyword: "dependencies",
		build: (tier) => ({ dependencies: { servers: withHidden(tier) } }),
		pointer: "/lsp/dependencies/servers/hidden",
	},
	{
		// The schema a string-encoded payload is validated against — an
		// entire published shape can live under one `contentSchema`.
		keyword: "contentSchema",
		build: (tier) => ({ contentSchema: withHidden(tier) }),
		pointer: "/lsp/contentSchema/hidden",
	},
	{
		keyword: "items (tuple form)",
		build: (tier) => ({ type: "array", items: [withHidden(tier)] }),
		pointer: "/lsp/items/0/hidden",
	},
];

describe("schema stability tiers reach every composition keyword (#2418)", () => {
	it("covers every keyword the walker claims to walk", () => {
		// Declared floor: an emptied case table must FAIL, not read as clean.
		expect(COMPOSITION_CASES.length).toBeGreaterThanOrEqual(16);
		expect(new Set(COMPOSITION_CASES.map((c) => c.keyword)).size).toBe(
			COMPOSITION_CASES.length,
		);
	});

	for (const { keyword, build, pointer } of COMPOSITION_CASES) {
		it(`catches an untiered property under ${keyword}`, () => {
			const mutant = envelopeWith(build());
			expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
				/missing x-stability/,
			);
			expect(() => assertSchemaStabilityTiers(mutant)).toThrow(pointer);
		});

		it(`accepts a tiered property under ${keyword}`, () => {
			expect(() =>
				assertSchemaStabilityTiers(envelopeWith(build("experimental"))),
			).not.toThrow();
		});

		it(`catches an unknown tier under ${keyword}`, () => {
			expect(() =>
				assertSchemaStabilityTiers(envelopeWith(build("beta"))),
			).toThrow(/invalid x-stability/);
		});
	}

	it("does not choke on the property-name-list form of dependencies", () => {
		// draft-07 lets `dependencies` map a property to an ARRAY OF NAMES
		// rather than a subschema. Nothing to tier there, and the walk must
		// step over it rather than treat the strings as a subschema.
		expect(() =>
			assertSchemaStabilityTiers(
				envelopeWith({ dependencies: { servers: ["command"] } }),
			),
		).not.toThrow();
	});

	it("does not choke on the boolean form of additionalProperties", () => {
		expect(() =>
			assertSchemaStabilityTiers(envelopeWith({ additionalProperties: false })),
		).not.toThrow();
	});

	it("terminates on a schema that shares a subschema object", () => {
		const shared = withHidden("stable");
		const schema = envelopeWith({ oneOf: [shared], anyOf: [shared] });
		expect(() => assertSchemaStabilityTiers(schema)).not.toThrow();
	});

	it("reports EVERY offender, not only the first", () => {
		const schema = envelopeWith({
			oneOf: [withHidden()],
			$defs: { spec: withHidden() },
		});
		let message = "";
		try {
			assertSchemaStabilityTiers(schema);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("/lsp/oneOf/0/hidden");
		expect(message).toContain("/lsp/$defs/spec/hidden");
	});
});

describe("config envelope identity anchor (#2418)", () => {
	it("accepts the reserved anchor", () => {
		expect(() =>
			assertSchemaIdentityAnchor(PLACEHOLDER_CONFIG_SCHEMA),
		).not.toThrow();
		expect(PLACEHOLDER_CONFIG_SCHEMA.$id).toBe(CONFIG_SCHEMA_ID);
	});

	it("fails a drifted $id", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		mutant.$id = "https://example.invalid/other.json";
		expect(() => assertSchemaIdentityAnchor(mutant)).toThrow(/\$id must be/);
	});

	it("fails a missing meta-schema declaration", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		delete mutant.$schema;
		expect(() => assertSchemaIdentityAnchor(mutant)).toThrow(/meta-schema/);
	});

	it("fails when the root drops the $schema instance property", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		delete (mutant.properties as Record<string, JsonSchemaNode>)[
			CONFIG_SCHEMA_ANCHOR_KEY
		];
		expect(() => assertSchemaIdentityAnchor(mutant)).toThrow(
			/instance property/,
		);
	});
});
