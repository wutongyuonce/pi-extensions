import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONFIG_DIAGNOSTIC_CODES,
	DEPRECATED_CONFIG_SURFACES,
} from "../../clients/config-diagnostic-codes.js";
import { PI_LENS_CONFIG_SCHEMA } from "../../clients/config-schema.js";
import type { JsonSchemaNode } from "../support/schema-stability.js";
import {
	assertPublicSurface,
	documentedIn,
	PLACEHOLDER_SURFACE_SCHEMA,
	publicSurfaceDrift,
	type PublicSurface,
	schemaEnumAt,
} from "../support/public-surface-drift.js";

/**
 * The generalized public-surface drift guard (#2427), run against the surfaces
 * that exist today and proven — each check, individually — by planting the
 * exact defect it is meant to catch.
 *
 * Two halves, and both are load-bearing:
 *
 * - The REAL registrations below fail CI when someone adds a config section
 *   with no reference-doc entry, a `PILENS_CFG_*` code the docs never mention,
 *   or a deprecation-registry row the migration table omits. Those are live
 *   failure modes: the schema derives its sections from
 *   `lens-flag-registry.ts`, so a new flag section appears in the published
 *   schema the moment it is registered, whether or not anyone wrote it down.
 * - The PLANTED reds prove the harness actually discriminates. #2418's own
 *   module doc makes the point: a fixture exists "so the harness's own
 *   positive/negative behavior is proven", and a guard whose negative case is
 *   never exercised is a guard that reads as coverage.
 *
 * The catalog/enum check has no real binding yet ON PURPOSE. Today's canonical
 * schema publishes no id enum — #2416 (LSP catalog) and #2383 (tool catalogs)
 * own that — so registering `LSP_SERVERS` against a non-existent enum would
 * either fail or, worse, pass vacuously. The check ships proven and unbound,
 * which is exactly the contract #2415 asked for: "ship the guard harness here
 * so catalog slices only add entries to it".
 */

/**
 * The canonical schema as a plain JSON-Schema object. It IS one — the whole
 * point of `clients/config-schema.ts` is that the validator's value and the
 * published artifact are the same object — but its declared type is the
 * narrower `ConfigSchemaNode`, whose `properties` is not a bare record.
 */
const SCHEMA = PI_LENS_CONFIG_SCHEMA as unknown as JsonSchemaNode;
const SCHEMA_PROPERTIES = SCHEMA.properties as Record<string, JsonSchemaNode>;

const DOCS_ROOT = path.resolve(__dirname, "..", "..", "docs");
const doc = (name: string) => path.join(DOCS_ROOT, name);

/**
 * The reference set, not one file. `docs/configuration.md` is the lookup-order
 * narrative and explicitly delegates the per-setting tables to the other three
 * under its own "See also"; requiring every section to appear in it would fail
 * on 14 sections that ARE documented, just not there.
 */
const CONFIG_DOCS = [
	doc("configuration.md"),
	doc("settings.md"),
	doc("globalconfig.md"),
	doc("environment-variables.md"),
];

const CONFIG_FILE_SURFACE: PublicSurface = {
	name: "pi-lens config file",
	schema: SCHEMA,
	docsPath: CONFIG_DOCS,
	codes: Object.keys(CONFIG_DIAGNOSTIC_CODES),
	catalogs: [
		{
			name: "deprecated config surfaces",
			ids: DEPRECATED_CONFIG_SURFACES.map((row) => row.surface),
			documented: true,
		},
	],
};

describe("public surface drift — real surfaces", () => {
	it("the canonical config schema, its docs, its codes and its deprecation registry agree", () => {
		expect(publicSurfaceDrift(CONFIG_FILE_SURFACE)).toEqual([]);
	});

	it("the registration is not vacuous — it really is walking fields, codes and catalog rows", () => {
		// Calibration in the spirit of `assertNonEmptyScan`: if a refactor emptied
		// any of the three inputs, every check above would pass by having nothing
		// to check.
		const codes = Object.keys(CONFIG_DIAGNOSTIC_CODES);
		expect(codes.length).toBeGreaterThanOrEqual(8);
		expect(DEPRECATED_CONFIG_SURFACES.length).toBeGreaterThanOrEqual(8);
		expect(Object.keys(SCHEMA_PROPERTIES).length).toBeGreaterThanOrEqual(20);
	});
});

describe("public surface drift — each check fails on a planted defect", () => {
	it("fails on an undocumented schema field", () => {
		const findings = publicSurfaceDrift({
			...CONFIG_FILE_SURFACE,
			schema: {
				...SCHEMA,
				properties: {
					...SCHEMA_PROPERTIES,
					undocumentedSectionZzz: { "x-stability": "stable" },
				},
			},
		});
		expect(findings.join("\n")).toContain("undocumentedSectionZzz");
		expect(findings.join("\n")).toContain("not documented");
	});

	it("fails on an untiered schema field", () => {
		expect(() =>
			assertPublicSurface({
				name: "planted",
				schema: {
					type: "object",
					properties: { untieredZzz: { type: "string" } },
				},
			}),
		).toThrow(/x-stability/);
	});

	it("fails on an undocumented diagnostic code", () => {
		const findings = publicSurfaceDrift({
			...CONFIG_FILE_SURFACE,
			codes: [...Object.keys(CONFIG_DIAGNOSTIC_CODES), "PILENS_CFG_9999"],
		});
		expect(findings.join("\n")).toContain("PILENS_CFG_9999");
	});

	it("fails on a deprecation-registry row the migration table never lists", () => {
		const findings = publicSurfaceDrift({
			...CONFIG_FILE_SURFACE,
			catalogs: [
				{
					name: "deprecated config surfaces",
					ids: [
						...DEPRECATED_CONFIG_SURFACES.map((row) => row.surface),
						"pi-lens-legacy-zzz.json",
					],
					documented: true,
				},
			],
		});
		expect(findings.join("\n")).toContain("pi-lens-legacy-zzz.json");
		expect(findings.join("\n")).toContain("reference docs");
	});

	it("fails on a built-in id the published schema enum omits", () => {
		const findings = publicSurfaceDrift({
			name: "planted catalog",
			catalogs: [
				{
					name: "servers",
					ids: ["rust", "python", "unlisted-server-zzz"],
					publishedIds: ["rust", "python"],
				},
			],
		});
		expect(findings.join("\n")).toContain("unlisted-server-zzz");
		expect(findings.join("\n")).toContain("published schema enum omits");
	});

	it("fails on a published enum id no registry entry backs", () => {
		const findings = publicSurfaceDrift({
			name: "planted catalog",
			catalogs: [
				{
					name: "servers",
					ids: ["rust"],
					publishedIds: ["rust", "ghost-server-zzz"],
				},
			],
		});
		expect(findings.join("\n")).toContain("ghost-server-zzz");
	});

	it("fails on a catalog entry with no smoke fixture, and passes once exempted", () => {
		const catalog = {
			name: "servers",
			ids: ["rust", "fixtureless-zzz"],
			fixtureIds: ["rust"],
		};
		expect(
			publicSurfaceDrift({ name: "planted", catalogs: [catalog] }).join("\n"),
		).toContain("fixtureless-zzz");
		expect(
			publicSurfaceDrift({
				name: "planted",
				catalogs: [
					{
						...catalog,
						fixtureExemptions: new Map([
							[
								"fixtureless-zzz",
								"alternate of rust; the preferred handshake covers it",
							],
						]),
					},
				],
			}),
		).toEqual([]);
	});

	it("fails on a fixture exemption for an id that no longer exists", () => {
		const findings = publicSurfaceDrift({
			name: "planted",
			catalogs: [
				{
					name: "servers",
					ids: ["rust"],
					fixtureIds: ["rust"],
					fixtureExemptions: new Map([["removed-server-zzz", "gone"]]),
				},
			],
		});
		expect(findings.join("\n")).toContain("removed-server-zzz");
		expect(findings.join("\n")).toContain("no longer exist");
	});
});

describe("public surface drift — helpers", () => {
	it("documentedIn does not accept an incidental substring", () => {
		// The whole reason the check is not `text.includes(name)`: prose that
		// merely uses the word must not count as documentation of the field.
		expect(documentedIn("pi-lens runs many tools for you.", "tools")).toBe(
			false,
		);
		expect(documentedIn("Set `tools.enabled` to false.", "tools")).toBe(true);
		expect(documentedIn('{ "tools": { } }', "tools")).toBe(true);
		expect(documentedIn("| `tools` | the tool section |", "tools")).toBe(true);
		expect(documentedIn("## tools", "tools")).toBe(true);
	});

	/**
	 * The check the case above asserted it performed and did not (#2427
	 * review round 2, F7).
	 *
	 * The old pattern matched the field name ANYWHERE inside a code span, so
	 * `ui` was "documented" by a sentence mentioning `builtin`, and every one of
	 * the short section names — `ui`, `lsp`, `delta`, `tools` — had a plausible
	 * carrier word in the reference docs. A drift guard that passes on a
	 * substring is a guard that cannot red, which is the defect it exists to
	 * catch.
	 */
	it("documentedIn requires a whole token inside a code span, heading or row", () => {
		expect(documentedIn("Set `builtin` to false.", "ui")).toBe(false);
		expect(documentedIn("| `builtin` | the builtin set |", "ui")).toBe(false);
		expect(documentedIn("## builtin servers", "ui")).toBe(false);
		expect(documentedIn("Set `guardrails` on.", "guard")).toBe(false);
		// A dotted or bracketed path is still the field being documented, so the
		// boundary is a TOKEN boundary, not a whitespace one.
		expect(documentedIn("Set `config.ui.compact` to false.", "ui")).toBe(true);
		expect(documentedIn("| `ui.compact` | compact mode |", "ui")).toBe(true);
		expect(documentedIn("## ui", "ui")).toBe(true);
	});

	it("schemaEnumAt reads an enum out of a schema, and reports its absence", () => {
		expect(
			schemaEnumAt(
				{ properties: { id: { enum: ["a", "b"] } } },
				"/properties/id",
			),
		).toEqual(["a", "b"]);
		// Today's canonical schema publishes no id enum — the catalog check has
		// nothing to bind to until #2416/#2383 land, and says so rather than
		// silently passing.
		expect(
			schemaEnumAt(SCHEMA, "/properties/lsp/properties/servers"),
		).toBeUndefined();
	});

	it("the placeholder surface passes every check it opts into", () => {
		expect(() =>
			assertPublicSurface({
				name: "placeholder",
				schema: PLACEHOLDER_SURFACE_SCHEMA,
			}),
		).not.toThrow();
	});
});
