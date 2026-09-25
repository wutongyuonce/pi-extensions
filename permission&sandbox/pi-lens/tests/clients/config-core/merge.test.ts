import { describe, expect, it } from "vitest";
import {
	type ConfigSource,
	merge,
} from "../../../clients/config-core/merge.js";
import {
	provenanceFor,
	type Resolved,
} from "../../../clients/config-core/provenance.js";
import type { ConfigSchemaNode } from "../../../clients/config-core/schema.js";
import {
	DEMO_CONFIG_SCHEMA,
	GOLDEN_SOURCES,
} from "../../support/config-core-fixtures.js";

function tierAt(
	resolved: Resolved<unknown>,
	pointer: string,
): string | undefined {
	return resolved.provenance.get(pointer)?.tier;
}

/** Every leaf pointer inside a resolved value, in document order. */
function leafPointers(value: unknown, prefix = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry, index) =>
			leafPointers(entry, `${prefix}/${index}`),
		);
	}
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([name, entry]) =>
			leafPointers(entry, `${prefix}/${name}`),
		);
	}
	return [prefix];
}

describe("golden four-tier resolution (#2425)", () => {
	const resolved = merge(GOLDEN_SOURCES, DEMO_CONFIG_SCHEMA);

	it("resolves every node by its declared rule", () => {
		expect(resolved.value).toEqual({
			lsp: {
				// builtin is the only tier that sets it, and nothing denies.
				enabled: true,
				// array-union deny: the global denial survives.
				disabledServers: ["gopls"],
				// replace: the nearest tier that sets it supplies the whole list.
				warmFiles: ["project.ts"],
				// append: every tier's entries, lowest precedence first.
				probes: ["builtin-probe", "global-probe", "project-probe"],
				// field-wise object: each key resolved on its own.
				timeouts: { initializeMs: 9000, clientWaitMs: 4000 },
				// keyed:id: entries matched across tiers, merged field-wise.
				servers: [
					{
						id: "pyright",
						command: "basedpyright-langserver",
						role: "auxiliary",
					},
					{
						id: "tailwind",
						command: "tailwindcss-language-server",
						role: "auxiliary",
					},
				],
			},
		});
	});

	it("attributes every resolved leaf to the tier that decided it", () => {
		expect(tierAt(resolved, "/lsp/enabled")).toBe("builtin");
		expect(tierAt(resolved, "/lsp/disabledServers")).toBe("global");
		expect(tierAt(resolved, "/lsp/warmFiles")).toBe("project");
		expect(tierAt(resolved, "/lsp/probes/0")).toBe("builtin");
		expect(tierAt(resolved, "/lsp/probes/1")).toBe("global");
		expect(tierAt(resolved, "/lsp/probes/2")).toBe("project");
		expect(tierAt(resolved, "/lsp/timeouts/initializeMs")).toBe(
			"nested-project",
		);
		expect(tierAt(resolved, "/lsp/timeouts/clientWaitMs")).toBe("global");
		expect(tierAt(resolved, "/lsp/servers/0/command")).toBe("global");
		expect(tierAt(resolved, "/lsp/servers/0/role")).toBe("project");
		expect(tierAt(resolved, "/lsp/servers/1/command")).toBe("project");
		expect(tierAt(resolved, "/lsp/servers/1/role")).toBe("nested-project");
	});

	it("carries the file and the trust decision alongside the tier", () => {
		expect(resolved.provenance.get("/lsp/servers/1/role")).toEqual({
			tier: "nested-project",
			key: "/lsp/servers/1/role",
			file: "packages/app/.pi-lens.json",
			trust: "trusted",
		});
		// A built-in default has no file and no trust question to answer.
		expect(resolved.provenance.get("/lsp/enabled")).toEqual({
			tier: "builtin",
			key: "/lsp/enabled",
		});
	});

	it("answers provenance for EVERY leaf, directly or through its array", () => {
		const unattributed = leafPointers(resolved.value).filter(
			(pointer) => provenanceFor(resolved, pointer) === undefined,
		);
		expect(unattributed).toEqual([]);
		expect(leafPointers(resolved.value).length).toBeGreaterThan(10);
	});

	it("is independent of the order the caller assembled its sources in", () => {
		const shuffled = [...GOLDEN_SOURCES].reverse();
		const other = merge(shuffled, DEMO_CONFIG_SCHEMA);
		expect(other.value).toEqual(resolved.value);
		expect([...other.provenance.entries()]).toEqual([
			...resolved.provenance.entries(),
		]);
	});
});

describe("merge strategies are per node, not per merger (#2425)", () => {
	const arraySchema = (strategy: string): ConfigSchemaNode => ({
		type: "object",
		properties: {
			list: {
				type: "array",
				items: { type: "string" },
				"x-merge-strategy": strategy,
			},
		},
	});

	const sources: readonly ConfigSource[] = [
		{ tier: "global", value: { list: ["a", "b"] } },
		{ tier: "project", value: { list: ["c"] } },
	];

	it("replaces by default when no strategy is declared", () => {
		const schema: ConfigSchemaNode = {
			type: "object",
			properties: { list: { type: "array", items: { type: "string" } } },
		};
		expect(merge(sources, schema).value).toEqual({ list: ["c"] });
	});

	it("replaces when asked", () => {
		expect(merge(sources, arraySchema("replace")).value).toEqual({
			list: ["c"],
		});
	});

	it("appends when asked", () => {
		expect(merge(sources, arraySchema("append")).value).toEqual({
			list: ["a", "b", "c"],
		});
	});

	it("falls back to replace for an unrecognized strategy", () => {
		expect(merge(sources, arraySchema("union-all")).value).toEqual({
			list: ["c"],
		});
	});

	it("merges keyed entries field-wise and appends unmatched ones", () => {
		const schema: ConfigSchemaNode = {
			type: "object",
			properties: {
				servers: {
					type: "array",
					"x-merge-strategy": "keyed:id",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							command: { type: "string" },
							role: { type: "string" },
						},
					},
				},
			},
		};
		const resolved = merge(
			[
				{ tier: "global", value: { servers: [{ id: "a", command: "one" }] } },
				{
					tier: "project",
					value: {
						servers: [{ id: "a", role: "auxiliary" }, { command: "no-id" }],
					},
				},
			],
			schema,
		);
		expect(resolved.value).toEqual({
			servers: [
				{ id: "a", command: "one", role: "auxiliary" },
				{ command: "no-id" },
			],
		});
	});
});

describe("objects are never replaced whole (#2415 scope item 1)", () => {
	it("keeps sibling keys a nearer tier did not mention", () => {
		const schema: ConfigSchemaNode = {
			type: "object",
			properties: {
				timeouts: {
					type: "object",
					properties: {
						a: { type: "integer" },
						b: { type: "integer" },
					},
				},
			},
		};
		const resolved = merge(
			[
				{ tier: "global", value: { timeouts: { a: 1, b: 2 } } },
				{ tier: "project", value: { timeouts: { b: 9 } } },
			],
			schema,
		);
		expect(resolved.value).toEqual({ timeouts: { a: 1, b: 9 } });
		expect(tierAt(resolved, "/timeouts/a")).toBe("global");
		expect(tierAt(resolved, "/timeouts/b")).toBe("project");
	});

	it("descends field-wise even where the schema is opaque about the shape", () => {
		// A schema that names no properties for the node. Replacing whole would
		// lose `a`; the merger falls back to the VALUE's shape instead.
		const schema: ConfigSchemaNode = {
			type: "object",
			properties: { bag: { type: "object", additionalProperties: true } },
		};
		const resolved = merge(
			[
				{ tier: "global", value: { bag: { a: 1, b: 2 } } },
				{ tier: "project", value: { bag: { b: 9 } } },
			],
			schema,
		);
		expect(resolved.value).toEqual({ bag: { a: 1, b: 9 } });
	});

	it("drops a source whose value did not survive validation", () => {
		const schema: ConfigSchemaNode = {
			type: "object",
			properties: { name: { type: "string" } },
		};
		const resolved = merge(
			[
				{ tier: "global", value: { name: "global" } },
				{ tier: "project", value: undefined },
			],
			schema,
		);
		expect(resolved.value).toEqual({ name: "global" });
		expect(tierAt(resolved, "/name")).toBe("global");
	});
});
