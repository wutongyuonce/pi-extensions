/**
 * The FIRST real schema through the #2418 harness (#2426).
 *
 * `tests/config/schema-stability-tiers.test.ts` proves the harness itself works
 * by running it over a placeholder fixture. That is necessary and not
 * sufficient: a harness whose only subject is its own fixture governs nothing.
 * This file points the same two assertions at the schema pi-lens actually
 * validates config with, which is what makes #2418's policy points 1 and 3
 * enforceable rather than aspirational.
 *
 * It also pins the two facts a reviewer would otherwise have to take on trust:
 * that the schema's namespace list is DERIVED from the flag/section registries
 * rather than hand-copied, and that the tier assigned to a deprecated key is
 * consistent with the removal schedule that same registry declares.
 */

import { describe, expect, it } from "vitest";
import {
	CONFIG_SCHEMA_ANCHOR_KEY,
	DEPRECATED_CONFIG_SURFACES,
	STABILITY_TIER_KEY,
} from "../../clients/config-diagnostic-codes.js";
import {
	LEGACY_ROOT_LSP_KEYS,
	LSP_NAMESPACE_KEY,
} from "../../clients/config-locations.js";
import {
	LSP_KEY_TYPES,
	PI_LENS_CONFIG_SCHEMA,
} from "../../clients/config-schema.js";
import {
	flagConfigSectionKeys,
	GLOBAL_NON_FLAG_CONFIG_SECTIONS,
	LENS_FLAGS,
	PROJECT_NON_FLAG_CONFIG_SECTIONS,
} from "../../clients/lens-flag-registry.js";
import {
	assertSchemaIdentityAnchor,
	assertSchemaStabilityTiers,
	type JsonSchemaNode,
} from "../support/schema-stability.js";

const schema = PI_LENS_CONFIG_SCHEMA as JsonSchemaNode;

function properties(node: JsonSchemaNode): Record<string, JsonSchemaNode> {
	return node.properties as Record<string, JsonSchemaNode>;
}

describe("the canonical pi-lens config schema (#2426 / #2418)", () => {
	it("passes the stability-tier walk", () => {
		expect(() => assertSchemaStabilityTiers(schema)).not.toThrow();
	});

	it("carries the reserved identity anchor", () => {
		expect(() => assertSchemaIdentityAnchor(schema)).not.toThrow();
		expect(properties(schema)[CONFIG_SCHEMA_ANCHOR_KEY]).toBeDefined();
	});

	it("goes red when a property loses its tier (the harness is live here)", () => {
		// The mutation that proves this file is not decorative: if the harness
		// could not see THIS schema's properties, deleting a tier would pass.
		const mutant = structuredClone(schema) as JsonSchemaNode;
		delete properties(mutant)[LSP_NAMESPACE_KEY][STABILITY_TIER_KEY];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
			/missing x-stability/,
		);
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(/\/lsp/);
	});

	it("goes red when a property INSIDE the lsp namespace loses its tier", () => {
		const mutant = structuredClone(schema) as JsonSchemaNode;
		const lsp = properties(mutant)[LSP_NAMESPACE_KEY];
		delete properties(lsp).servers[STABILITY_TIER_KEY];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(/\/lsp\/servers/);
	});

	it("declares every registry-derived section, with none invented by hand", () => {
		// Single source of truth: the schema's top-level namespaces are exactly
		// the registries' sections plus `lsp`, the legacy root keys, and the
		// identity anchor. A section added to a registry appears here for free; a
		// section added ONLY here fails this test.
		const declared = new Set(Object.keys(properties(schema)));
		for (const key of [
			...flagConfigSectionKeys(LENS_FLAGS),
			...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
			...PROJECT_NON_FLAG_CONFIG_SECTIONS,
		]) {
			expect(declared.has(key), key).toBe(true);
		}
	});

	it("reserves the lsp namespace without defining the #2416 server shape", () => {
		const lsp = properties(schema)[LSP_NAMESPACE_KEY];
		expect(lsp.type).toBe("object");
		// Open: #2416 adds `lsp.servers.<id>`'s fields, and until it does an
		// unrecognized key inside `lsp` must survive rather than be dropped.
		expect(lsp.additionalProperties).toBe(true);
		const servers = properties(lsp).servers;
		expect(servers.type).toBe("object");
		expect(servers.properties).toBeUndefined();
	});

	it("types every canonical lsp key the deprecation registry names", () => {
		for (const key of LEGACY_ROOT_LSP_KEYS) {
			expect(LSP_KEY_TYPES[key], key).toBeDefined();
			expect(properties(properties(schema)[LSP_NAMESPACE_KEY])[key].type).toBe(
				LSP_KEY_TYPES[key],
			);
		}
	});

	it("never calls a scheduled-for-removal key stable", () => {
		// Two registries, one fact: a key with a `removeNotBefore` cannot also
		// carry the tier that promises compatibility.
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			if (row.kind !== "key") continue;
			expect(
				properties(schema)[row.surface][STABILITY_TIER_KEY],
				row.surface,
			).toBe("experimental");
			expect(
				properties(properties(schema)[LSP_NAMESPACE_KEY])[row.surface][
					STABILITY_TIER_KEY
				],
				row.surface,
			).toBe("experimental");
		}
	});

	it("keeps the ROOT open so the loaders keep their own unknown-key prose", () => {
		// Deliberate override of pi-lens's closed default, argued in
		// `config-schema.ts`'s module doc. Pinned so a later "tighten the schema"
		// change has to confront the diagnostics it would silently replace.
		expect(schema.additionalProperties).toBe(true);
	});
});
