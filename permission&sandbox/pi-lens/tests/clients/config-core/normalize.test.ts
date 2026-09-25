import { describe, expect, it } from "vitest";
import { CONFIG_DIAGNOSTIC_CODES } from "../../../clients/config-diagnostic-codes.js";
import {
	MAX_CONFIG_DEPTH,
	validate,
} from "../../../clients/config-core/normalize.js";
import {
	boundedKeyLabel,
	MAX_MIGRATION_RECORDS,
	MAX_RECORD_KEY_LENGTH,
	MigrationRecordCollector,
	migrationSubject,
} from "../../../clients/config-core/records.js";
import type { ConfigSchemaNode } from "../../../clients/config-core/schema.js";
import { DEMO_CONFIG_SCHEMA } from "../../support/config-core-fixtures.js";

const NUL = String.fromCharCode(0);

describe("validate: unknown fields are warned and dropped, never thrown on (#2425)", () => {
	it("drops a field no schema property claims and records a registered code", () => {
		const result = validate(
			{ lsp: { enabled: true }, telemetryEndpoint: "https://example.invalid" },
			DEMO_CONFIG_SCHEMA,
			{ file: ".pi-lens.json" },
		);
		expect(result.value).toEqual({ lsp: { enabled: true } });
		expect(result.records).toHaveLength(1);
		const [record] = result.records;
		expect(record.code).toBe("PILENS_CFG_0004");
		expect(CONFIG_DIAGNOSTIC_CODES[record.code]).toBeTruthy();
		expect(record.key).toBe("/telemetryEndpoint");
		expect(record.file).toBe(".pi-lens.json");
		expect(record.subject).toBe(`.pi-lens.json${NUL}/telemetryEndpoint`);
	});

	it("drops an unknown NESTED field and names its full pointer", () => {
		const result = validate(
			{ lsp: { enabled: true, unheardOf: 1 } },
			DEMO_CONFIG_SCHEMA,
		);
		expect(result.value).toEqual({ lsp: { enabled: true } });
		expect(result.records.map((entry) => entry.key)).toEqual([
			"/lsp/unheardOf",
		]);
	});

	it("never throws, whatever the raw value is", () => {
		for (const raw of [null, 42, "text", [], undefined, true]) {
			expect(() => validate(raw, DEMO_CONFIG_SCHEMA)).not.toThrow();
		}
		expect(validate([], DEMO_CONFIG_SCHEMA).value).toBeUndefined();
	});

	it("keeps unknown keys under an open sub-object", () => {
		const result = validate(
			{
				lsp: {
					servers: [
						{ id: "x", initializationOptions: { anything: { deep: 1 } } },
					],
				},
			},
			DEMO_CONFIG_SCHEMA,
		);
		expect(result.records).toEqual([]);
		expect(result.value).toEqual({
			lsp: {
				servers: [
					{ id: "x", initializationOptions: { anything: { deep: 1 } } },
				],
			},
		});
	});
});

describe("validate: schema violations are dropped with PILENS_CFG_0005 (#2425)", () => {
	it("drops a wrong-typed scalar and names the expected type only", () => {
		const result = validate(
			{ lsp: { enabled: "yes-please" } },
			DEMO_CONFIG_SCHEMA,
		);
		expect(result.value).toEqual({ lsp: {} });
		expect(result.records[0].code).toBe("PILENS_CFG_0005");
		expect(result.records[0].reason).toBe(
			"expected boolean, got string; ignored",
		);
		expect(result.records[0].reason).not.toContain("yes-please");
	});

	it("drops an object where an array was declared", () => {
		const result = validate(
			{ lsp: { probes: { zero: "a" } } },
			DEMO_CONFIG_SCHEMA,
		);
		expect(result.value).toEqual({ lsp: {} });
		expect(result.records[0].reason).toBe(
			"expected an array, got object; ignored",
		);
	});

	it("drops one bad array item and keeps the rest", () => {
		const result = validate(
			{ lsp: { probes: ["a", 7, "b"] } },
			DEMO_CONFIG_SCHEMA,
		);
		expect(result.value).toEqual({ lsp: { probes: ["a", "b"] } });
		expect(result.records.map((entry) => entry.key)).toEqual(["/lsp/probes/1"]);
	});

	it("drops a value outside a declared enum and names the allowed members", () => {
		const result = validate(
			{ lsp: { servers: [{ id: "x", role: "sidecar" }] } },
			DEMO_CONFIG_SCHEMA,
		);
		expect(result.value).toEqual({ lsp: { servers: [{ id: "x" }] } });
		expect(result.records[0].reason).toBe(
			'value is not one of "language", "auxiliary"; ignored',
		);
		expect(result.records[0].reason).not.toContain("sidecar");
	});

	it("rejects a non-integer where integer is declared", () => {
		const result = validate(
			{ lsp: { timeouts: { initializeMs: 1.5 } } },
			DEMO_CONFIG_SCHEMA,
		);
		expect(result.value).toEqual({ lsp: { timeouts: {} } });
		expect(result.records[0].reason).toBe(
			"expected integer, got number; ignored",
		);
	});
});

describe("validate is bounded on both growing axes (#2425)", () => {
	const openSchema: ConfigSchemaNode = {
		type: "object",
		properties: {
			nest: { type: "object", properties: {} },
		},
	};

	it("stops at MAX_CONFIG_DEPTH instead of recursing without bound", () => {
		let deep: Record<string, unknown> = { leaf: 1 };
		for (let level = 0; level < MAX_CONFIG_DEPTH + 5; level += 1) {
			deep = { nest: deep };
		}
		// A schema as deep as the value, so nothing is dropped as unknown and the
		// depth bound is the only thing that can stop the walk.
		let schemaNode: ConfigSchemaNode = {
			type: "object",
			additionalProperties: true,
		};
		for (let level = 0; level < MAX_CONFIG_DEPTH + 5; level += 1) {
			schemaNode = {
				type: "object",
				properties: { nest: schemaNode },
			};
		}
		const result = validate(deep, schemaNode);
		expect(
			result.records.some((entry) => /nesting exceeds/.test(entry.reason)),
		).toBe(true);
	});

	it("refuses a self-referential value rather than overflowing the stack", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.nest = cyclic;
		const result = validate(cyclic, openSchema);
		expect(result.records.map((entry) => entry.reason)).toContain(
			"config value refers to itself; ignored",
		);
	});

	it("caps records at MAX_MIGRATION_RECORDS and counts the overflow", () => {
		const raw: Record<string, unknown> = {};
		for (let index = 0; index < MAX_MIGRATION_RECORDS + 7; index += 1) {
			raw[`unknown${index}`] = index;
		}
		const result = validate(raw, DEMO_CONFIG_SCHEMA);
		expect(result.records).toHaveLength(MAX_MIGRATION_RECORDS);
		expect(result.droppedRecordCount).toBe(7);
	});

	it("shares one bound across sources when the collector is shared", () => {
		const collector = new MigrationRecordCollector(3);
		for (const file of ["a.json", "b.json"]) {
			validate({ nope1: 1, nope2: 2 }, DEMO_CONFIG_SCHEMA, { file, collector });
		}
		expect(collector.records).toHaveLength(3);
		expect(collector.droppedCount).toBe(1);
	});
});

describe("records never carry file content (#2425 / sibling #2431)", () => {
	const SECRET = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

	it("keeps the offending VALUE out of every record field", () => {
		const result = validate({ lsp: { enabled: SECRET } }, DEMO_CONFIG_SCHEMA, {
			file: ".pi-lens.json",
		});
		const serialized = JSON.stringify(result.records);
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("ghp_");
	});

	it("redacts a secret spelled as a KEY, which is the one user text a record quotes", () => {
		const result = validate({ [SECRET]: 1 }, DEMO_CONFIG_SCHEMA, {
			file: ".pi-lens.json",
		});
		const serialized = JSON.stringify(result.records);
		expect(result.records).toHaveLength(1);
		expect(serialized).not.toContain(SECRET);
		expect(serialized).toContain("[REDACTED:github-token]");
	});

	it("bounds and de-fangs a hostile key name", () => {
		const hostile = `${"k".repeat(MAX_RECORD_KEY_LENGTH + 40)}`;
		const label = boundedKeyLabel(hostile);
		expect(label.length).toBeLessThanOrEqual(MAX_RECORD_KEY_LENGTH + 3);
		const multiline = boundedKeyLabel(
			["first", "second"].join(String.fromCharCode(10)),
		);
		expect(multiline).toBe("first second");
		expect(multiline).not.toContain(String.fromCharCode(10));
	});

	it("uses the ledger subject shape the warn seam expects", () => {
		expect(migrationSubject("a.json", "/lsp")).toBe(`a.json${NUL}/lsp`);
		expect(migrationSubject("a.json", "")).toBe("a.json");
	});
});
