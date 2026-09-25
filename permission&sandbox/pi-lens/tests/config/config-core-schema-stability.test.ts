import { describe, expect, it } from "vitest";
import { STABILITY_TIER_KEY } from "../../clients/config-diagnostic-codes.js";
import {
	DENY_KEY,
	MERGE_STRATEGY_KEY,
	denyPolicyOf,
	isDenyPolicy,
	isMergeStrategy,
	mergeStrategyOf,
} from "../../clients/config-core/schema.js";
import {
	assertSchemaIdentityAnchor,
	assertSchemaStabilityTiers,
	type JsonSchemaNode,
} from "../support/schema-stability.js";
import { CONFIG_CORE_SCHEMAS } from "../support/config-core-fixtures.js";

/**
 * #2418 policy points 1 and 3, applied to every schema #2425 defines. The
 * harness is the one shipped with #2418 rather than a second walker — a
 * per-consumer walker is how a tier requirement stops being one requirement.
 */
describe("every schema this slice defines carries the stability contract", () => {
	it("has schemas to check", () => {
		// Declared floor: an emptied fixture list must FAIL, not read as clean.
		expect(CONFIG_CORE_SCHEMAS.length).toBeGreaterThanOrEqual(2);
	});

	for (const { name, schema } of CONFIG_CORE_SCHEMAS) {
		it(`${name}: every published property carries a valid x-stability tier`, () => {
			expect(() => assertSchemaStabilityTiers(schema)).not.toThrow();
		});

		it(`${name}: carries the reserved config-envelope identity anchor`, () => {
			expect(() => assertSchemaIdentityAnchor(schema)).not.toThrow();
		});

		it(`${name}: the tier gate is armed, not vacuous`, () => {
			// The harness only proves something if removing a tier makes it red.
			const mutant = structuredClone(schema) as JsonSchemaNode;
			const properties = mutant.properties as Record<string, JsonSchemaNode>;
			const [first] = Object.keys(properties);
			delete properties[first][STABILITY_TIER_KEY];
			expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
				/missing x-stability/,
			);
		});
	}
});

describe("the pi-lens schema annotations are read, not guessed (#2425)", () => {
	it("defaults an un-annotated array node to replace", () => {
		expect(mergeStrategyOf({ type: "array" })).toBe("replace");
		expect(mergeStrategyOf(undefined)).toBe("replace");
	});

	it("reads each declared strategy", () => {
		for (const strategy of ["replace", "append", "keyed:id"]) {
			expect(mergeStrategyOf({ [MERGE_STRATEGY_KEY]: strategy })).toBe(
				strategy,
			);
			expect(isMergeStrategy(strategy)).toBe(true);
		}
	});

	it("rejects a malformed strategy rather than inventing one", () => {
		expect(isMergeStrategy("keyed:")).toBe(false);
		expect(isMergeStrategy("merge")).toBe(false);
		expect(isMergeStrategy(7)).toBe(false);
		expect(mergeStrategyOf({ [MERGE_STRATEGY_KEY]: "keyed:" })).toBe("replace");
	});

	it("reads a deny policy only from the annotation, never from a field name", () => {
		expect(denyPolicyOf({ [DENY_KEY]: "boolean-false" })).toBe("boolean-false");
		expect(denyPolicyOf({ [DENY_KEY]: "array-union" })).toBe("array-union");
		// A field NAMED like a deny but not annotated carries no deny semantics.
		expect(
			denyPolicyOf({ type: "array", title: "disabledServers" }),
		).toBeUndefined();
		expect(isDenyPolicy("deny")).toBe(false);
	});
});
