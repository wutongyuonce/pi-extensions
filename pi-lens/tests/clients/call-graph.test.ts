import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCallGraph,
	CALL_GRAPH_CACHE_VERSION,
	formatImpact,
	impact,
	loadCallGraph,
	saveCallGraph,
	type FunctionCallGraph,
} from "../../clients/call-graph.js";
import type { Symbol, SymbolRef } from "../../clients/symbol-types.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { removeTempDirSync } from "./test-utils.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function sym(
	filePath: string,
	name: string,
	kind: Symbol["kind"] = "function",
	line = 1,
	endLine?: number,
): Symbol {
	return {
		id: `${filePath}:${name}`,
		name,
		kind,
		filePath,
		line,
		...(endLine === undefined ? {} : { endLine }),
		column: 1,
		isExported: true,
	};
}

function ref(callerFile: string, refName: string, line = 5): SymbolRef {
	return {
		symbolId: `${callerFile}:${refName}`,
		filePath: callerFile,
		line,
		column: 1,
	};
}

function validPersistedCallGraph(): Record<string, unknown> {
	const callerFile = "/proj/a.ts";
	const calleeFile = "/proj/b.ts";
	const callerKey = `${callerFile}:caller`;
	const calleeKey = `${calleeFile}:callee`;
	return {
		version: CALL_GRAPH_CACHE_VERSION,
		builtAt: "2026-08-04T00:00:00.000Z",
		reviewGraphVersion: "v9",
		reviewGraphSignature: "sig-valid",
		edges: [
			{
				callerFile,
				callerSymbol: "caller",
				callerKey,
				calleeFile,
				calleeSymbol: "callee",
				calleeKey,
				evidenceKind: "calls",
				resolution: "exact",
				evidenceCount: 1,
				weight: 1,
			},
		],
		callees: [[callerKey, [calleeKey]]],
		callers: [[calleeKey, [callerKey]]],
		inDegree: [[calleeKey, 1]],
		totalRefs: 1,
		unresolvedRefs: 0,
		coverage: {
			totalEvidence: 1,
			callsEvidence: 1,
			referencesEvidence: 0,
			eligibleEvidence: 1,
			resolvedEvidence: 1,
			unresolvedEvidence: 0,
			typeOnlyEvidence: 0,
			unsupportedEvidence: 0,
			sameFileEvidence: 0,
			duplicateEvidence: 0,
			complete: true,
			languages: { typescript: "complete" },
		},
	};
}

let tmpDir: string;
beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cg-"));
});
afterEach(() => {
	removeTempDirSync(tmpDir);
});

// ── buildCallGraph ─────────────────────────────────────────────────────────────

describe("buildCallGraph", () => {
	it("does not claim complete coverage for an empty direct graph", () => {
		const graph = buildCallGraph(new Map(), new Map());
		expect(graph.edges).toHaveLength(0);
		expect(graph.coverage?.complete).toBe(false);
	});

	it("resolves a cross-file call and populates both directions", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";

		const allSymbols = new Map([
			[fileA, [sym(fileA, "doThing", "function", 1)]],
			[fileB, [sym(fileB, "helper", "function", 1)]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "helper", 5)]], // a.ts calls helper from b.ts
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		expect(graph.totalRefs).toBeGreaterThan(0);

		// Callee map: doThing → {b.ts:helper}
		const callerKey = `${fileA}:doThing`;
		const calleeKey = `${fileB}:helper`;
		expect(graph.callees.get(callerKey)?.has(calleeKey)).toBe(true);

		// Caller map: helper → {a.ts:doThing}
		expect(graph.callers.get(calleeKey)?.has(callerKey)).toBe(true);
	});

	it("does not create edges for same-file refs", () => {
		const fileA = "/proj/a.ts";

		const allSymbols = new Map([
			[fileA, [sym(fileA, "foo"), sym(fileA, "bar")]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "bar", 5)]], // a.ts calls bar — also in a.ts
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		// No cross-file edges — no callee/caller entries expected
		expect(graph.callees.size).toBe(0);
		expect(graph.callers.size).toBe(0);
	});

	it("normalizes divergent caller path casing for same-file classification", () => {
		// Windows-shaped paths exercise normalizeMapKey's case/separator fold on
		// both Windows and Linux CI without assuming the host filesystem casing.
		const canonical = "C:\\Proj\\Caller.ts";
		const divergent = "c:/proj/caller.ts";
		const allSymbols = new Map([
			[divergent, [sym(canonical, "caller"), sym(canonical, "helper")]],
		]);
		const graph = buildCallGraph(
			allSymbols,
			new Map([
				[
					divergent,
					[
						{
							...ref(divergent, "helper"),
							targetId: `${canonical}:helper`,
							resolution: "exact",
						},
					],
				],
			]),
		);
		expect(graph.callees.size).toBe(0);
		expect(graph.callers.size).toBe(0);
		expect(graph.coverage?.sameFileEvidence).toBe(1);
	});

	it("uses the file-level fallback after a completed function", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const graph = buildCallGraph(
			new Map([
				[fileA, [sym(fileA, "done", "function", 1, 3)]],
				[fileB, [sym(fileB, "init")]],
			]),
			new Map([[fileA, [ref(fileA, "init", 5)]]]),
		);
		expect(graph.callees.has(`file:${fileA}`)).toBe(true);
		expect(graph.callees.has(`${fileA}:done`)).toBe(false);
	});

	it("respects nested and adjacent function end boundaries", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const graph = buildCallGraph(
			new Map([
				[
					fileA,
					[
						sym(fileA, "outer", "function", 1, 10),
						sym(fileA, "inner", "function", 3, 5),
					],
				],
				[fileB, [sym(fileB, "target")]],
			]),
			new Map([
				[
					fileA,
					[
						ref(fileA, "target", 4),
						ref(fileA, "target", 7),
						ref(fileA, "target", 12),
					],
				],
			]),
		);
		expect(graph.callees.has(`${fileA}:inner`)).toBe(true);
		expect(graph.callees.has(`${fileA}:outer`)).toBe(true);
		expect(graph.callees.has(`file:${fileA}`)).toBe(true);
	});

	it("applies ambiguity discounting when multiple files define same name", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const fileC = "/proj/c.ts";

		const allSymbols = new Map([
			[fileA, []],
			[fileB, [sym(fileB, "shared")]],
			[fileC, [sym(fileC, "shared")]],
		]);
		const allRefs = new Map([[fileA, [ref(fileA, "shared", 3)]]]);

		const graph = buildCallGraph(allSymbols, allRefs);

		// Legacy name-only resolution retains every cross-file candidate; no
		// candidate may disappear merely because Map iteration happened to put it
		// second.
		expect(graph.edges.map((edge) => edge.calleeKey).sort()).toEqual(
			[`${fileB}:shared`, `${fileC}:shared`].sort(),
		);
		for (const edge of graph.edges) {
			expect(edge.weight).toBe(0.5);
			expect(edge.resolution).toBe("name-only");
		}
		expect(graph.coverage).toMatchObject({
			totalEvidence: 1,
			eligibleEvidence: 1,
			resolvedEvidence: 1,
			duplicateEvidence: 0,
		});
	});

	it("round-trips ambiguous legacy evidence without false semantic staleness", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		try {
			const fileA = "/proj/a.ts";
			const fileB = "/proj/b.ts";
			const fileC = "/proj/c.ts";
			const graph = buildCallGraph(
				new Map([
					[fileA, [sym(fileA, "caller")]],
					[fileB, [sym(fileB, "shared")]],
					[fileC, [sym(fileC, "shared")]],
				]),
				new Map([[fileA, [ref(fileA, "shared")]]]),
			);

			saveCallGraph("/proj", graph, {
				reviewGraphVersion: "v7",
				reviewGraphSignature: "sig-ambiguous",
			});
			expect(loadCallGraph("/proj")?.graph.coverage).toMatchObject({
				totalEvidence: 1,
				resolvedEvidence: 1,
			});
		} finally {
			delete process.env.PILENS_DATA_DIR;
		}
	});

	it("classifies canonical same-file evidence as unsupported and persists cross-file edges", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		try {
			const fileA = "/proj/a.ts";
			const fileB = "/proj/b.ts";
			const sameFileId = `${fileA}:target:function:3`;
			const crossFileId = `${fileB}:remote:function:3`;
			const callerId = `${fileA}:caller:function:10`;
			const graph = buildCallGraph(
				new Map([
					[
						fileA,
						[
							{ ...sym(fileA, "target", "function", 3), id: sameFileId },
							{ ...sym(fileA, "caller", "function", 10), id: callerId },
						],
					],
					[
						fileB,
						[{ ...sym(fileB, "remote", "function", 3), id: crossFileId }],
					],
				]),
				new Map([
					[
						fileA,
						[
							{
								...ref(fileA, "target", 4),
								targetId: sameFileId,
								evidenceKind: "calls",
								referenceKind: "call",
								resolution: "exact",
							},
							{
								...ref(fileA, "remote", 11),
								targetId: crossFileId,
								callerSymbolId: callerId,
								evidenceKind: "calls",
								referenceKind: "call",
								resolution: "exact",
							},
						],
					],
				]),
				{
					totalEvidence: 2,
					callsEvidence: 2,
					referencesEvidence: 0,
					eligibleEvidence: 2,
					resolvedEvidence: 2,
					unresolvedEvidence: 0,
					typeOnlyEvidence: 0,
					unsupportedEvidence: 0,
					sameFileEvidence: 0,
					duplicateEvidence: 0,
					complete: true,
				},
			);
			expect(graph.edges).toHaveLength(1);
			expect(graph.coverage).toMatchObject({
				resolvedEvidence: 1,
				eligibleEvidence: 1,
				sameFileEvidence: 1,
				unsupportedEvidence: 0,
				complete: true,
			});
			saveCallGraph("/proj", graph, {
				reviewGraphVersion: "v7",
				reviewGraphSignature: "sig-same-file",
			});
			const loaded = loadCallGraph("/proj");
			expect(loaded?.graph.callees.get(callerId)).toEqual(
				new Set([crossFileId]),
			);
			expect(loaded?.graph.callers.get(crossFileId)).toEqual(
				new Set([callerId]),
			);
			expect(loaded?.graph.coverage).toMatchObject({
				resolvedEvidence: 1,
				sameFileEvidence: 1,
				unsupportedEvidence: 0,
				complete: true,
			});
		} finally {
			delete process.env.PILENS_DATA_DIR;
		}
	});

	// refs #1089 P3-1 (audit repro shape): the same-file check must compare
	// NORMALIZED paths, and — for a ref with exactly one candidate (the
	// canonical targetId path) — must count sameFileEvidence exactly ONCE per
	// ref, not once per candidate. A raw (unnormalized) compare would fail to
	// recognize two divergent spellings of the SAME file as "same file" and
	// misclassify the evidence as cross-file/resolved instead; a per-candidate
	// double count would push resolvedEvidence + ... + sameFileEvidence above
	// totalEvidence. Either bug breaks validatePersistedCallGraph's coverage
	// sum invariant, so a graph built from divergent path forms would be
	// silently rejected by loadCallGraph on every subsequent load — a
	// perpetual cache miss reproduced from a real adapter shape (backslash vs
	// forward-slash spellings of the same Windows-style path).
	it("normalizes divergent path forms for the same-file check and counts sameFileEvidence once per ref (#1089 P3-1)", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		try {
			// Same actual file, two different spellings — exactly the class of
			// divergence a review-graph adapter and a tree-sitter extractor can
			// disagree on (backslash vs forward-slash).
			const callerFileForwardSlash = "C:/proj/a.ts";
			const callerFileBackslash = "C:\\proj\\a.ts";
			const targetId = `${callerFileForwardSlash}:target:function:3`;
			const callerId = `${callerFileForwardSlash}:caller:function:10`;

			const allSymbols = new Map<string, Symbol[]>([
				[
					callerFileForwardSlash,
					[
						{
							...sym(callerFileForwardSlash, "target", "function", 3),
							id: targetId,
						},
						{
							...sym(callerFileForwardSlash, "caller", "function", 10),
							id: callerId,
						},
					],
				],
			]);
			// The ref's OWN filePath/callerFile is spelled with backslashes —
			// divergent from the symbol's forward-slash filePath above, but the
			// same file on disk.
			const allRefs = new Map<string, SymbolRef[]>([
				[
					callerFileBackslash,
					[
						{
							...ref(callerFileBackslash, "target", 4),
							targetId,
							callerSymbolId: callerId,
							evidenceKind: "calls",
							referenceKind: "call",
							resolution: "exact",
						},
					],
				],
			]);

			const graph = buildCallGraph(allSymbols, allRefs, {
				totalEvidence: 1,
				callsEvidence: 1,
				referencesEvidence: 0,
				eligibleEvidence: 1,
				resolvedEvidence: 1,
				unresolvedEvidence: 0,
				typeOnlyEvidence: 0,
				unsupportedEvidence: 0,
				sameFileEvidence: 0,
				duplicateEvidence: 0,
				complete: true,
			});

			// Recognized as same-file (not left as a phantom cross-file edge).
			expect(graph.edges).toHaveLength(0);
			// Counted exactly once, and the coverage sum invariant holds — this
			// is the exact arithmetic validatePersistedCallGraph enforces on load.
			const c = graph.coverage;
			if (!c) throw new Error("expected coverage on a freshly built graph");
			expect(c.sameFileEvidence).toBe(1);
			expect(
				c.resolvedEvidence +
					c.unresolvedEvidence +
					c.typeOnlyEvidence +
					c.unsupportedEvidence +
					c.sameFileEvidence,
			).toBe(c.totalEvidence);

			// And the round trip through the real persistence path survives the
			// same validator that rejects a broken-sum graph on every load.
			saveCallGraph("/proj", graph, {
				reviewGraphVersion: "v7",
				reviewGraphSignature: "sig-divergent-path-forms",
			});
			const loaded = loadCallGraph("/proj");
			expect(loaded).toBeDefined();
			expect(loaded?.graph.coverage?.sameFileEvidence).toBe(1);
		} finally {
			delete process.env.PILENS_DATA_DIR;
		}
	});

	it("counts duplicate evidence once while keeping centrality on logical edges", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const callerId = `${fileA}:caller:function:1`;
		const calleeId = `${fileB}:callee:function:1`;
		const allSymbols = new Map<string, Symbol[]>([
			[fileA, [{ ...sym(fileA, "caller"), id: callerId }]],
			[fileB, [{ ...sym(fileB, "callee"), id: calleeId }]],
		]);
		const allRefs = new Map<string, SymbolRef[]>([
			[
				fileA,
				[
					{
						...ref(fileA, "callee"),
						targetId: calleeId,
						callerSymbolId: callerId,
						evidenceKind: "calls",
						referenceKind: "call",
					},
					{
						...ref(fileA, "callee", 6),
						targetId: calleeId,
						callerSymbolId: callerId,
						evidenceKind: "calls",
						referenceKind: "call",
					},
				],
			],
		]);

		const graph = buildCallGraph(allSymbols, allRefs);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0].evidenceCount).toBe(2);
		expect(graph.coverage).toMatchObject({
			totalEvidence: 2,
			duplicateEvidence: 1,
			eligibleEvidence: 2,
			resolvedEvidence: 2,
		});
		expect(graph.inDegree.get(calleeId)).toBe(1);
		process.env.PILENS_DATA_DIR = tmpDir;
		try {
			saveCallGraph("/proj", graph, {
				reviewGraphVersion: "v7",
				reviewGraphSignature: "sig-duplicate",
			});
			const loaded = loadCallGraph("/proj");
			expect(loaded?.graph.edges[0].evidenceCount).toBe(2);
			expect(loaded?.graph.coverage?.duplicateEvidence).toBe(1);
			expect(loaded?.graph.callees.get(callerId)).toEqual(new Set([calleeId]));
			expect(loaded?.graph.callers.get(calleeId)).toEqual(new Set([callerId]));
			expect(loaded?.graph.inDegree.get(calleeId)).toBe(1);
		} finally {
			delete process.env.PILENS_DATA_DIR;
		}
	});

	it("filters stdlib names from resolution", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";

		const allSymbols = new Map([
			[fileA, []],
			[fileB, [sym(fileB, "console"), sym(fileB, "Math")]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "console", 2), ref(fileA, "Math", 3)]],
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		expect(graph.edges).toHaveLength(0);
	});

	it("falls back to file-level caller key when no enclosing function found", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";

		// fileA has no function symbols — ref is at module level
		const allSymbols = new Map([
			[fileA, []],
			[fileB, [sym(fileB, "init")]],
		]);
		const allRefs = new Map([[fileA, [ref(fileA, "init", 1)]]]);

		const graph = buildCallGraph(allSymbols, allRefs);

		const callerKey = `file:${fileA}`;
		expect(graph.callees.get(callerKey)?.size).toBe(1);
	});

	it("accumulates weighted in-degree correctly", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const fileC = "/proj/c.ts";

		const allSymbols = new Map([
			[fileA, [sym(fileA, "caller1"), sym(fileA, "caller2")]],
			[fileB, []],
			[fileC, [sym(fileC, "shared")]],
		]);
		// Two distinct callers each call shared once (weight=1.0 each)
		const allRefs = new Map([
			[fileA, [ref(fileA, "shared", 3), ref(fileA, "shared", 10)]],
			[fileB, [ref(fileB, "shared", 5)]],
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		const calleeKey = `${fileC}:shared`;
		const inDeg = graph.inDegree.get(calleeKey) ?? 0;
		// Each unambiguous ref contributes weight 1.0
		expect(inDeg).toBeGreaterThan(0);
	});
});

// ── impact() ──────────────────────────────────────────────────────────────────

function makeGraph(
	edges: Array<{ callerKey: string; calleeKey: string; weight?: number }>,
): FunctionCallGraph {
	const callees = new Map<string, Set<string>>();
	const callers = new Map<string, Set<string>>();
	const inDegree = new Map<string, number>();
	const resolvedEdges = edges.map((e) => ({
		callerFile: e.callerKey.split(":")[0] ?? "",
		callerSymbol: e.callerKey.split(":")[1],
		callerKey: e.callerKey,
		calleeFile: e.calleeKey.split(":")[0] ?? "",
		calleeSymbol: e.calleeKey.split(":")[1] ?? e.calleeKey,
		calleeKey: e.calleeKey,
		weight: e.weight ?? 1.0,
	}));

	for (const edge of resolvedEdges) {
		const ec = callees.get(edge.callerKey) ?? new Set();
		ec.add(edge.calleeKey);
		callees.set(edge.callerKey, ec);
		const cr = callers.get(edge.calleeKey) ?? new Set();
		cr.add(edge.callerKey);
		callers.set(edge.calleeKey, cr);
		inDegree.set(
			edge.calleeKey,
			(inDegree.get(edge.calleeKey) ?? 0) + edge.weight!,
		);
	}

	return {
		callees,
		callers,
		inDegree,
		edges: resolvedEdges,
		unresolvedRefs: 0,
		totalRefs: 0,
		builtAt: "",
	};
}

describe("impact()", () => {
	it("returns empty for a symbol with no callers", () => {
		const g = makeGraph([{ callerKey: "a:foo", calleeKey: "b:bar" }]);
		expect(impact(g, "a:foo")).toHaveLength(0);
	});

	it("classifies depth-1 as WillBreak", () => {
		const g = makeGraph([{ callerKey: "a:caller", calleeKey: "b:callee" }]);
		const results = impact(g, "b:callee");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			symbolKey: "a:caller",
			depth: 1,
			severity: "WillBreak",
		});
	});

	it("classifies depth-2 as MayBreak", () => {
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "c:C", calleeKey: "a:A" },
		]);
		const results = impact(g, "b:B");
		const c = results.find((r) => r.symbolKey === "c:C");
		expect(c?.severity).toBe("MayBreak");
		expect(c?.depth).toBe(2);
	});

	it("classifies depth-3 as Review", () => {
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "c:C", calleeKey: "a:A" },
			{ callerKey: "d:D", calleeKey: "c:C" },
		]);
		const results = impact(g, "b:B");
		const d = results.find((r) => r.symbolKey === "d:D");
		expect(d?.severity).toBe("Review");
		expect(d?.depth).toBe(3);
	});

	it("respects maxDepth — does not traverse beyond it", () => {
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "c:C", calleeKey: "a:A" },
		]);
		const results = impact(g, "b:B", 1);
		expect(results.map((r) => r.symbolKey)).not.toContain("c:C");
	});

	it("does not revisit already-visited nodes (cycle safety)", () => {
		// A → B → A (cycle)
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "b:B", calleeKey: "a:A" },
		]);
		const results = impact(g, "b:B");
		const keys = results.map((r) => r.symbolKey);
		// Should not loop; each key appears at most once
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("filters low-weight edges when minWeight > edge weight", () => {
		const g = makeGraph([{ callerKey: "a:A", calleeKey: "b:B", weight: 0.05 }]);
		const results = impact(g, "b:B", 3, 0.1);
		expect(results).toHaveLength(0);
	});

	it("results are sorted by depth then symbolKey", () => {
		const g = makeGraph([
			{ callerKey: "z:Z", calleeKey: "b:B" },
			{ callerKey: "a:A", calleeKey: "b:B" },
		]);
		const results = impact(g, "b:B");
		expect(results[0].symbolKey < results[1].symbolKey).toBe(true);
	});
});

describe("formatImpact()", () => {
	it("returns empty string for empty results", () => {
		expect(formatImpact([], "/proj")).toBe("");
	});

	it("formats WillBreak callers", () => {
		const g = makeGraph([
			{
				callerKey: "/proj/a.ts:handleRequest",
				calleeKey: "/proj/b.ts:changed",
			},
		]);
		const results = impact(g, "/proj/b.ts:changed");
		const summary = formatImpact(results, "/proj");
		expect(summary).toContain("WillBreak");
		expect(summary).toContain("handleRequest");
	});

	it("formats Windows-style paths relative to the project root", () => {
		const root = path.join(tmpDir, "Repo");
		const caller = path.join(root, "src", "caller.ts").replace(/\\/g, "\\\\");
		const result = [
			{
				symbolKey: `${caller}:caller`,
				depth: 1,
				severity: "WillBreak" as const,
			},
		];
		expect(formatImpact(result, root.toLowerCase())).toContain("src/caller.ts");
	});

	it("mentions Review count when present", () => {
		const g = makeGraph([
			{ callerKey: "/proj/a.ts:A", calleeKey: "/proj/b.ts:B" },
			{ callerKey: "/proj/c.ts:C", calleeKey: "/proj/a.ts:A" },
			{ callerKey: "/proj/d.ts:D", calleeKey: "/proj/c.ts:C" },
		]);
		const results = impact(g, "/proj/b.ts:B");
		const summary = formatImpact(results, "/proj");
		expect(summary).toContain("Review");
	});
});

// ── Persistence ────────────────────────────────────────────────────────────────

describe("saveCallGraph / loadCallGraph", () => {
	it("round-trips callees, callers, and inDegree correctly", () => {
		process.env.PILENS_DATA_DIR = tmpDir;

		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const allSymbols = new Map([
			[fileA, [sym(fileA, "caller")]],
			[fileB, [sym(fileB, "callee")]],
		]);
		const allRefs = new Map([[fileA, [ref(fileA, "callee", 5)]]]);

		const graph = buildCallGraph(allSymbols, allRefs);

		saveCallGraph("/proj", graph, {
			reviewGraphVersion: "v7",
			reviewGraphSignature: "sig-roundtrip",
		});
		const loaded = loadCallGraph("/proj");

		expect(loaded).toBeDefined();
		const callerKey = `${fileA}:caller`;
		const calleeKey = `${fileB}:callee`;
		expect(loaded?.graph.callees.get(callerKey)?.has(calleeKey)).toBe(true);
		expect(loaded?.graph.callers.get(calleeKey)?.has(callerKey)).toBe(true);

		delete process.env.PILENS_DATA_DIR;
	});

	it("reconstructs legacy evidence totals when coverage metadata is absent", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const callerKey = `${fileA}:caller`;
		const calleeKey = `${fileB}:callee`;
		const cacheFile = path.join(
			getProjectDataDir("/proj"),
			"cache",
			"call-graph.json",
		);
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		// Deliberately pinned to the literal 4, one below CALL_GRAPH_CACHE_VERSION, to
		// exercise the legacy-format rejection path itself. If CALL_GRAPH_CACHE_VERSION
		// is ever bumped to 4 this assertion fails loudly instead of the test
		// silently testing nothing (the #1082/#1106 vacuous-fixture class).
		expect(CALL_GRAPH_CACHE_VERSION).not.toBe(4);
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({
				version: 4,
				builtAt: "legacy",
				fileMtimes: {},
				edges: [
					{
						callerFile: fileA,
						callerKey,
						calleeFile: fileB,
						calleeSymbol: "callee",
						calleeKey,
						weight: 1,
					},
				],
				callees: [[callerKey, [calleeKey]]],
				callers: [[calleeKey, [callerKey]]],
				inDegree: [[calleeKey, 1]],
			}),
			"utf-8",
		);

		// v4 is legacy: no canonical review-graph identity means unavailable,
		// rather than a seemingly clean migrated projection.
		expect(loadCallGraph("/proj")).toBeUndefined();
		delete process.env.PILENS_DATA_DIR;
	});

	it("round-trips evidence metadata and coverage", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const callerId = `${fileA}:caller:function:4`;
		const calleeId = `${fileB}:target:method:27`;
		const allSymbols = new Map<string, Symbol[]>([
			[
				fileA,
				[
					{
						id: callerId,
						name: "caller",
						kind: "function",
						filePath: fileA,
						line: 4,
						column: 2,
						isExported: true,
					},
				],
			],
			[
				fileB,
				[
					{
						id: calleeId,
						name: "target",
						kind: "method",
						filePath: fileB,
						line: 27,
						column: 3,
						isExported: true,
					},
				],
			],
		]);
		const allRefs = new Map<string, SymbolRef[]>([
			[
				fileA,
				[
					{
						symbolId: `${fileA}:target`,
						symbolName: "target",
						filePath: fileA,
						line: 9,
						column: 7,
						evidenceKind: "calls",
						referenceKind: "call",
						targetId: calleeId,
						callerSymbolId: callerId,
						resolution: "import",
					},
				],
			],
		]);
		const coverage = {
			totalEvidence: 1,
			callsEvidence: 1,
			referencesEvidence: 0,
			eligibleEvidence: 1,
			resolvedEvidence: 1,
			unresolvedEvidence: 0,
			typeOnlyEvidence: 0,
			unsupportedEvidence: 0,
			sameFileEvidence: 0,
			duplicateEvidence: 0,
			complete: true,
		};
		const graph = buildCallGraph(allSymbols, allRefs, coverage);
		saveCallGraph("/proj", graph, {
			reviewGraphVersion: "v8",
			reviewGraphSignature: "sig-evidence",
		});
		const loaded = loadCallGraph("/proj");
		expect(loaded?.graph.edges[0]).toMatchObject({
			calleeKey: calleeId,
			calleeSymbol: "target",
			calleeKind: "method",
			evidenceKind: "calls",
			resolution: "import",
		});
		expect(loaded?.graph.coverage).toMatchObject({
			callsEvidence: 1,
			complete: true,
		});
		delete process.env.PILENS_DATA_DIR;
	});

	// These two fixtures MUST be v5 with a valid canonical identity — a v4 (or
	// identity-less) fixture is rejected by loadCallGraph's version/identity gate
	// (call-graph.ts ~787-788) before validatePersistedCallGraph ever runs, which
	// would make these tests pass even if the semantic validator were deleted
	// (the vacuous-test class flagged in #1089). Each test's own comment records
	// the specific validator check it exercises, and that check was confirmed to
	// fail pre-fix by temporarily disabling it (see #1089 fix commit).
	it("rejects parseable JSON with inconsistent adjacency and centrality", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		const cacheFile = path.join(
			getProjectDataDir("/proj"),
			"cache",
			"call-graph.json",
		);
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		const raw = validPersistedCallGraph() as {
			edges: Array<{ calleeKey: string }>;
			inDegree: unknown;
		};
		// The persisted inDegree for the callee (2) disagrees with what the single
		// edge actually implies (1) — exercises the actualInDegree/expectedInDegree
		// cross-check (call-graph.ts ~767-769), not just adjacency shape.
		raw.inDegree = [[raw.edges[0].calleeKey, 2]];
		fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");
		expect(loadCallGraph("/proj")).toBeUndefined();
		delete process.env.PILENS_DATA_DIR;
	});

	it("rejects complete coverage that contains unsupported evidence", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		const cacheFile = path.join(
			getProjectDataDir("/proj"),
			"cache",
			"call-graph.json",
		);
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		const raw = validPersistedCallGraph() as {
			coverage: Record<string, unknown>;
			totalRefs: number;
		};
		// complete: true with unsupportedEvidence > 0 exercises the honesty check
		// at call-graph.ts ~686 ("complete" must mean nothing was unsupported) —
		// keep every other coverage identity/sum invariant (incl. raw.totalRefs,
		// which must track coverage.totalEvidence per the ~736 cross-check) so
		// this is the ONE thing that fails.
		raw.coverage = {
			totalEvidence: 2,
			callsEvidence: 1,
			referencesEvidence: 1,
			eligibleEvidence: 1,
			resolvedEvidence: 1,
			unresolvedEvidence: 0,
			typeOnlyEvidence: 0,
			unsupportedEvidence: 1,
			sameFileEvidence: 0,
			duplicateEvidence: 0,
			complete: true,
		};
		raw.totalRefs = 2;
		fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");
		expect(loadCallGraph("/proj")).toBeUndefined();
		delete process.env.PILENS_DATA_DIR;
	});

	it("rejects malformed v5 semantic fields instead of serving a partial graph", () => {
		const mutations: Array<[string, (raw: Record<string, any>) => void]> = [
			[
				"non-boolean coverage.complete",
				(raw) => {
					raw.coverage.complete = "true";
				},
			],
			[
				"unknown evidence enum",
				(raw) => {
					raw.edges[0].evidenceKind = "not-an-evidence-kind";
				},
			],
			[
				"unknown resolution enum",
				(raw) => {
					raw.edges[0].resolution = "guessed";
				},
			],
			[
				"empty graph identity",
				(raw) => {
					raw.reviewGraphSignature = "";
				},
			],
			[
				"empty edge identity",
				(raw) => {
					raw.edges[0].calleeSymbol = "";
				},
			],
			[
				"edge/file identity mismatch",
				(raw) => {
					raw.edges[0].calleeFile = "/proj/other.ts";
				},
			],
			[
				"duplicate logical edges",
				(raw) => {
					raw.edges.push({ ...raw.edges[0] });
				},
			],
			[
				"duplicate adjacency targets",
				(raw) => {
					raw.callees[0][1].push(raw.callees[0][1][0]);
				},
			],
			[
				"duplicate adjacency entries",
				(raw) => {
					raw.callers.push([...raw.callers[0]]);
				},
			],
		];

		for (const [label, mutate] of mutations) {
			process.env.PILENS_DATA_DIR = tmpDir;
			try {
				const raw = validPersistedCallGraph();
				mutate(raw);
				const cacheFile = path.join(
					getProjectDataDir("/proj"),
					"cache",
					"call-graph.json",
				);
				fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
				fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");
				expect(loadCallGraph("/proj"), label).toBeUndefined();
			} finally {
				delete process.env.PILENS_DATA_DIR;
			}
		}
	});

	it("accepts a strict v5 cache with consistent semantic metadata", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		try {
			const raw = validPersistedCallGraph();
			const cacheFile = path.join(
				getProjectDataDir("/proj"),
				"cache",
				"call-graph.json",
			);
			fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
			fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");
			expect(loadCallGraph("/proj")?.graph.coverage).toMatchObject({
				complete: true,
				totalEvidence: 1,
			});
		} finally {
			delete process.env.PILENS_DATA_DIR;
		}
	});

	it("returns undefined for missing cache", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		expect(loadCallGraph("/nonexistent")).toBeUndefined();
		delete process.env.PILENS_DATA_DIR;
	});

	// #1089: "freshness is owned exclusively by the review-graph snapshot" (see
	// the module doc comment) is only true if callers actually pass
	// `expectedIdentity` and loadCallGraph actually enforces it. Before this
	// change, no test anywhere in the suite passed `expectedIdentity` — a
	// regression that dropped the check (the #210/#1020 stale-replay class)
	// would have shipped green.
	describe("canonical-freshness invariant (expectedIdentity)", () => {
		it("rejects a cache saved under one reviewGraphVersion when loaded expecting another", () => {
			process.env.PILENS_DATA_DIR = tmpDir;
			try {
				const raw = validPersistedCallGraph();
				const cacheFile = path.join(
					getProjectDataDir("/proj"),
					"cache",
					"call-graph.json",
				);
				fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
				fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");
				// Sanity: loads fine with no expectation, or a matching one.
				expect(loadCallGraph("/proj")).toBeDefined();
				expect(
					loadCallGraph("/proj", {
						reviewGraphVersion: "v9",
						reviewGraphSignature: "sig-valid",
					}),
				).toBeDefined();
				// A different reviewGraphVersion is a stale-replay: reject.
				expect(
					loadCallGraph("/proj", {
						reviewGraphVersion: "v10",
						reviewGraphSignature: "sig-valid",
					}),
				).toBeUndefined();
			} finally {
				delete process.env.PILENS_DATA_DIR;
			}
		});

		it("rejects a cache saved under one reviewGraphSignature when loaded expecting another", () => {
			process.env.PILENS_DATA_DIR = tmpDir;
			try {
				const raw = validPersistedCallGraph();
				const cacheFile = path.join(
					getProjectDataDir("/proj"),
					"cache",
					"call-graph.json",
				);
				fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
				fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");
				// Same version, but the source content signature moved on — this is
				// exactly the case a changed file must invalidate.
				expect(
					loadCallGraph("/proj", {
						reviewGraphVersion: "v9",
						reviewGraphSignature: "sig-newer",
					}),
				).toBeUndefined();
			} finally {
				delete process.env.PILENS_DATA_DIR;
			}
		});

		it("loads successfully when the expected identity matches exactly", () => {
			process.env.PILENS_DATA_DIR = tmpDir;
			try {
				const raw = validPersistedCallGraph();
				const cacheFile = path.join(
					getProjectDataDir("/proj"),
					"cache",
					"call-graph.json",
				);
				fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
				fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");
				const loaded = loadCallGraph("/proj", {
					reviewGraphVersion: "v9",
					reviewGraphSignature: "sig-valid",
				});
				expect(loaded).toBeDefined();
				expect(loaded?.identity).toEqual({
					reviewGraphVersion: "v9",
					reviewGraphSignature: "sig-valid",
				});
			} finally {
				delete process.env.PILENS_DATA_DIR;
			}
		});
	});
});
