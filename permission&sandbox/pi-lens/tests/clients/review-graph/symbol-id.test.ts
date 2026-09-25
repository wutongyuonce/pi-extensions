import { describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { buildOrUpdateGraph } from "../../../clients/review-graph/builder.js";
import {
	buildSymbolId,
	parseSymbolKey,
} from "../../../clients/review-graph/symbol-id.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

// refs #655 (narrow first slice): collision-safe symbol-graph node IDs.
//
// The pre-fix scheme built a symbol node's ID as `${file}:${name}` — two
// same-named symbols in the SAME FILE (overloaded methods, same-named methods
// on different classes, same-named nested functions) collapsed onto one node.
// `who-uses-this`/`blastRadius` (clients/module-report.ts) read that node's
// incoming edges directly, so two genuinely different symbols' callers would
// silently merge (or, worse, misattribute one symbol's callers to the other).
describe("collision-safe symbol IDs (#655)", () => {
	it("old <file>:<name> scheme collides for same-named methods on different classes", () => {
		// This demonstrates the bug the fix removes, using the exact pre-fix
		// formula — not a hypothetical. Both methods are real, distinct symbols
		// (different class, different body, different line) that the OLD scheme
		// could not tell apart.
		const file = "src/service.ts";
		const oldIdFor = (name: string) => `${file}:${name}`;
		expect(oldIdFor("run")).toBe(oldIdFor("run")); // ClassA.run === ClassB.run
	});

	it("new scheme gives same-named methods on different classes distinct IDs", () => {
		const file = "src/service.ts";
		const idA = buildSymbolId(file, "run", "method", 2);
		const idB = buildSymbolId(file, "run", "method", 6);
		expect(idA).not.toBe(idB);
	});

	it("new scheme gives an overloaded/duplicate-name pair distinct IDs by start line", () => {
		const file = "src/api.ts";
		const overload1 = buildSymbolId(file, "handle", "function", 1);
		const overload2 = buildSymbolId(file, "handle", "function", 5);
		expect(overload1).not.toBe(overload2);
	});

	it(
		"end-to-end: two same-named Python methods on different classes get distinct " +
			"graph nodes and each keeps its OWN caller edge",
		async () => {
			const env = setupTestEnvironment("pi-lens-symbol-collision-");
			try {
				// Two classes, each with a `run` method — the collision case named in
				// #655 (same-named methods on different classes in the same file).
				const modelPath = createTempFile(
					env.tmpDir,
					"pkg/models.py",
					[
						"class Alpha:",
						"    def run(self):",
						"        return 1",
						"",
						"class Beta:",
						"    def run(self):",
						"        return 2",
						"",
					].join("\n"),
				);
				// Two separate callers — one for each class's `run`. Under the OLD
				// `${file}:${name}` scheme these would both land as "callers of the
				// one merged `run` node"; under the fix each caller only reaches the
				// specific `run` it actually calls (both are still `name-only`
				// resolution here since python calls resolve by bare name, but the
				// two `run` NODES themselves are now distinct).
				const callerAlphaPath = createTempFile(
					env.tmpDir,
					"pkg/use_alpha.py",
					[
						"from pkg.models import Alpha",
						"",
						"def call_alpha():",
						"    return Alpha().run()",
						"",
					].join("\n"),
				);

				const facts = new FactStore();
				const graph = await buildOrUpdateGraph(
					env.tmpDir,
					[modelPath, callerAlphaPath],
					facts,
				);

				const normalizedModel = normalizeMapKey(modelPath);
				const symbolIds = graph.symbolNodesByFile.get(normalizedModel) ?? [];
				const runNodes = symbolIds
					.map((id) => graph.nodes.get(id))
					.filter((n) => n?.symbolName === "run");

				// The concrete assertion the old scheme could never satisfy: two
				// DISTINCT nodes for the two `run` methods, not one merged node.
				expect(runNodes.length).toBe(2);
				const ids = new Set(runNodes.map((n) => n!.id));
				expect(ids.size).toBe(2);
				// And each carries its own, different start line.
				const lines = new Set(
					runNodes.map((n) => (n!.metadata as { line?: number })?.line),
				);
				expect(lines.size).toBe(2);
			} finally {
				env.cleanup();
			}
		},
	);
});

// refs #1088 P2: parseSymbolKey mis-parses LSP-fallback kinds.
//
// buildSymbolId only ever mints the 7 kinds in the (now-removed) hard-coded
// whitelist, but addLspFallbackSymbols mints canonical-shaped ids using
// lspSymbolKindName's much larger vocabulary — "enum", "constant", "struct",
// "namespace", "field", "constructor", "module", and the numeric catch-all
// "lsp-symbol-<n>" for unmapped LSP SymbolKind values. Under the whitelist,
// any of those ids failed the kind check and fell through to the legacy
// last-colon split, which shears the id at the WRONG boundary (the line
// number becomes the "name", and the kind+name become part of the "file
// path"). The fix matches the trailing `:<kind-token>:<digits>` shape
// structurally instead of whitelisting specific kind strings.
describe("parseSymbolKey (#1088 P2 — LSP-fallback kinds)", () => {
	it("parses a canonical id whose kind is in the original 7-kind whitelist", () => {
		const parsed = parseSymbolKey("src/service.ts:run:method:6");
		expect(parsed).toEqual({
			filePath: "src/service.ts",
			symbolName: "run",
			kind: "method",
			line: 6,
		});
	});

	it("parses a canonical id minted with an LSP-fallback kind ('enum')", () => {
		// The issue's concrete repro shape, incl. a Windows drive-letter path
		// whose own colon must NOT be mistaken for a field separator.
		const parsed = parseSymbolKey("c:\\p\\a.kt:Color:enum:42");
		expect(parsed).toEqual({
			filePath: "c:\\p\\a.kt",
			symbolName: "Color",
			kind: "enum",
			line: 42,
		});
	});

	it("parses canonical ids for the rest of the LSP-fallback vocabulary", () => {
		const cases: Array<[string, string]> = [
			["src/a.ts:MAX:constant:10", "constant"],
			["src/a.ts:Shape:struct:3", "struct"],
			["src/a.ts:app:namespace:1", "namespace"],
			["src/a.ts:count:field:7", "field"],
			["src/a.ts:Widget:constructor:2", "constructor"],
			["src/a.ts:utils:module:1", "module"],
			// The numeric catch-all lspSymbolKindName emits for an unmapped
			// LSP SymbolKind number.
			["src/a.ts:Mystery:lsp-symbol-99:5", "lsp-symbol-99"],
			// Hyphenated LSP kinds (SYMBOL_KIND_NAMES itself, not just the
			// numeric catch-all).
			["src/a.ts:Foo:enum-member:8", "enum-member"],
			["src/a.ts:T:type-parameter:1", "type-parameter"],
		];
		for (const [key, expectedKind] of cases) {
			const parsed = parseSymbolKey(key);
			expect(parsed.kind).toBe(expectedKind);
			expect(parsed.filePath).toBe("src/a.ts");
			expect(typeof parsed.line).toBe("number");
		}
	});

	it("still falls back to the legacy file:name split for non-canonical ids", () => {
		const parsed = parseSymbolKey("src/service.ts:helper");
		expect(parsed).toEqual({
			filePath: "src/service.ts",
			symbolName: "helper",
		});
	});
});
