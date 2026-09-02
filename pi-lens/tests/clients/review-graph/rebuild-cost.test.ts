import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	_getReviewGraphRebuildCountersForTests,
	_resetReviewGraphRebuildCountersForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getGraphImportChanges,
} from "../../../clients/review-graph/builder.js";
import type {
	ReviewGraph,
	ReviewGraphEdge,
} from "../../../clients/review-graph/types.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

/**
 * A ring of `count` modules where every module imports and calls two others.
 * Node and edge counts therefore scale linearly with `count`, while the fan-in
 * of any single file stays at 2 — exactly the shape the #2074 acceptance
 * criteria need to separate per-graph cost from per-changed-file cost.
 */
function makeRing(count: number): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2074-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
	fs.writeFileSync(path.join(root, ".git"), "");
	const src = path.join(root, "src");
	fs.mkdirSync(src, { recursive: true });
	for (let i = 0; i < count; i++) {
		const a = (i + 1) % count;
		const b = (i + 2) % count;
		fs.writeFileSync(
			path.join(src, `file${i}.ts`),
			`import { fn${a} } from "./file${a}.js";\n` +
				`import { fn${b} } from "./file${b}.js";\n` +
				`export function fn${i}(): number {\n` +
				`\treturn fn${a}() + fn${b}();\n` +
				`}\n`,
		);
	}
	return root;
}

/** A real source graph where every caller points at one changed symbol. */
function makeFanIn(count: number): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2074-fanin-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
	fs.writeFileSync(path.join(root, ".git"), "");
	const src = path.join(root, "src");
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(
		path.join(src, "target.ts"),
		"export function shared(): number {\n\treturn 1;\n}\n",
	);
	for (let i = 0; i < count; i++) {
		fs.writeFileSync(
			path.join(src, `caller${i}.ts`),
			`import { shared } from "./target.js";\n` +
				`export function caller${i}(): number {\n\treturn shared();\n}\n`,
		);
	}
	return root;
}

function maxCallFanIn(graph: ReviewGraph): number {
	const byTarget = new Map<string, number>();
	for (const edge of graph.edges) {
		if (edge.kind !== "calls") continue;
		byTarget.set(edge.to, (byTarget.get(edge.to) ?? 0) + 1);
	}
	return Math.max(0, ...byTarget.values());
}

/** A project with exactly the given files, ready for a seq-fast-path rebuild. */
function makeProject(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2074-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
	fs.writeFileSync(path.join(root, ".git"), "");
	for (const [relative, body] of Object.entries(files)) {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body);
	}
	return root;
}

/** Full edge identity, including target — the dedupe key plus `to`. */
function fullEdgeKey(edge: ReviewGraphEdge): string {
	return JSON.stringify([edge.from, edge.to, edge.kind, edge.metadata ?? {}]);
}

function duplicateEdgeCount(graph: ReviewGraph): number {
	const counts = new Map<string, number>();
	for (const edge of graph.edges) {
		const key = fullEdgeKey(edge);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.values()].filter((count) => count > 1).length;
}

interface RebuildProbe {
	graph: ReviewGraph;
	counters: {
		restoreComparisons: number;
		importTargetEdgeScans: number;
		removeOwnedEdgeVisits: number;
		removeOwnedEdgePositions: number;
	};
	nodes: number;
	edges: number;
}

/**
 * Warm the graph, then edit ONE file and rebuild through the #451 seq fast
 * path, counting only the rebuild's work.
 */
async function warmThenRebuildOneFile(
	root: string,
	changedRelative = "file0.ts",
): Promise<RebuildProbe> {
	const changed = path.join(root, "src", changedRelative);
	let seq = 0;
	const seqHint = {
		projectSeq: () => seq,
		getFilesChangedSince: () => [changed],
	};
	await buildOrUpdateGraph(root, [changed], new FactStore(), seqHint);
	seq++;
	fs.appendFileSync(changed, "\nexport const marker0 = 1;\n");
	clearGraphCache();
	_resetReviewGraphRebuildCountersForTests();
	const graph = await buildOrUpdateGraph(
		root,
		[changed],
		new FactStore(),
		seqHint,
	);
	return {
		graph,
		counters: _getReviewGraphRebuildCountersForTests(),
		nodes: graph.nodes.size,
		edges: graph.edges.length,
	};
}

/**
 * Warm the graph, then edit EVERY file in `changedRelative` in one batch and
 * rebuild through the #451 seq fast path, counting only the rebuild's work.
 */
async function warmThenRebuildFiles(
	root: string,
	changedRelative: string[],
): Promise<RebuildProbe> {
	const changed = changedRelative.map((relative) =>
		path.join(root, "src", relative),
	);
	let seq = 0;
	const seqHint = {
		projectSeq: () => seq,
		getFilesChangedSince: () => changed,
	};
	await buildOrUpdateGraph(root, changed, new FactStore(), seqHint);
	seq++;
	for (const file of changed) {
		fs.appendFileSync(file, "\nexport const marker = 1;\n");
	}
	clearGraphCache();
	_resetReviewGraphRebuildCountersForTests();
	const graph = await buildOrUpdateGraph(
		root,
		changed,
		new FactStore(),
		seqHint,
	);
	return {
		graph,
		counters: _getReviewGraphRebuildCountersForTests(),
		nodes: graph.nodes.size,
		edges: graph.edges.length,
	};
}

/**
 * Snapshot of the four derived indexes, preserving BUCKET ORDER.
 *
 * Order matters, not just membership: `resolveUsedBy` in `clients/module-report.ts`
 * walks `edgesByTo` and truncates at a cap, so bucket order decides which callers
 * a reader is shown. `rebuildIndexes` orders every bucket by position in
 * `graph.edges`; the incremental path must match that exactly. Comparing bucket
 * LENGTHS only would pass on a graph whose buckets hold the right edges in the
 * wrong order, which is the divergence this snapshot exists to catch.
 *
 * Edges are identified by content, not object identity, so a reference built
 * from `graph.edges` and the live index compare equal when they agree.
 */
type IndexSnapshot = {
	edgesByFrom: Array<[string, string[]]>;
	edgesByTo: Array<[string, string[]]>;
	fileNodes: Array<[string, string]>;
	symbolNodesByFile: Array<[string, string[]]>;
};

function edgeIdentity(edge: ReviewGraphEdge): string {
	return JSON.stringify([
		edge.from,
		edge.to,
		edge.kind,
		edge.resolution ?? null,
		edge.metadata ?? {},
	]);
}

const byKey = <T>(entries: Array<[string, T]>): Array<[string, T]> =>
	[...entries].sort(([a], [b]) => a.localeCompare(b));

/** What `rebuildIndexes` would produce for `graph`, in `graph.edges` order. */
function referenceIndexes(graph: ReviewGraph): IndexSnapshot {
	const edgesByFrom = new Map<string, string[]>();
	const edgesByTo = new Map<string, string[]>();
	const fileNodes = new Map<string, string>();
	const symbolNodesByFile = new Map<string, string[]>();
	for (const node of graph.nodes.values()) {
		if (node.kind === "file" && node.filePath) {
			fileNodes.set(node.filePath, node.id);
		}
		if (node.kind === "symbol" && node.filePath) {
			const ids = symbolNodesByFile.get(node.filePath) ?? [];
			ids.push(node.id);
			symbolNodesByFile.set(node.filePath, ids);
		}
	}
	for (const edge of graph.edges) {
		const identity = edgeIdentity(edge);
		const from = edgesByFrom.get(edge.from) ?? [];
		from.push(identity);
		edgesByFrom.set(edge.from, from);
		const to = edgesByTo.get(edge.to) ?? [];
		to.push(identity);
		edgesByTo.set(edge.to, to);
	}
	return {
		edgesByFrom: byKey([...edgesByFrom]),
		edgesByTo: byKey([...edgesByTo]),
		fileNodes: byKey([...fileNodes]),
		symbolNodesByFile: byKey([...symbolNodesByFile]),
	};
}

/** The indexes `graph` actually carries, in the same shape. */
function liveIndexes(graph: ReviewGraph): IndexSnapshot {
	const identities = (
		map: Map<string, ReviewGraphEdge[]>,
	): Array<[string, string[]]> =>
		byKey(
			[...map]
				.filter(([, edges]) => edges.length > 0)
				.map(([key, edges]) => [key, edges.map(edgeIdentity)]),
		);
	return {
		edgesByFrom: identities(graph.edgesByFrom),
		edgesByTo: identities(graph.edgesByTo),
		fileNodes: byKey([...graph.fileNodes]),
		symbolNodesByFile: byKey(
			[...graph.symbolNodesByFile].filter(([, ids]) => ids.length > 0),
		),
	};
}

describe("review-graph one-file rebuild cost (#2074)", () => {
	it(
		"keeps rebuild work proportional to the changed file, not the graph",
		{ timeout: 240_000 },
		async () => {
			// Ring sizes are kept as small as the 4x ratio allows: this file's peak
			// RSS sits in the unit suite's heavy tail (tree-sitter and TS-compiler
			// arenas, ~1.4 GB at 40/160 files), and the CI runner has been killed
			// at exit 137 for less.
			const small = await warmThenRebuildOneFile(makeRing(16));
			const large = await warmThenRebuildOneFile(makeRing(64));

			// Sanity: the fixture really did scale, so an O(graph) cost would show.
			expect(large.nodes).toBeGreaterThan(small.nodes * 3);
			expect(large.edges).toBeGreaterThan(small.edges * 3);

			// AC1a: metadata comparisons in restoreValidIncomingEdges are bounded by
			// the preserved-incoming set of the ONE changed file, so they do not
			// move when the graph quadruples. Before #2074 this counted one
			// JSON.stringify per edge in the whole graph.
			expect(large.counters.restoreComparisons).toBe(
				small.counters.restoreComparisons,
			);

			// AC1b: importTargetsForFile reads the changed file's own edgesByFrom
			// bucket. Before #2074 it scanned graph.edges twice per changed file.
			expect(large.counters.importTargetEdgeScans).toBe(
				small.counters.importTargetEdgeScans,
			);
			expect(large.counters.importTargetEdgeScans).toBeLessThan(
				small.edges / 2,
			);
		},
	);

	it(
		"keeps owned-edge removal proportional to the changed files, not batch size times the graph",
		{ timeout: 240_000 },
		async () => {
			// A 2-file batch: before #2074, removeFileOwnedGraphData scanned the
			// WHOLE graph.edges array once per changed file in the batch, so a
			// multi-file rebuild cost changedFiles x graph, not changedFiles x
			// fan-in/out. Two files changed per fixture isolates that multiplier
			// from the graph-size axis this suite already covers with one file.
			const small = await warmThenRebuildFiles(makeRing(16), [
				"file0.ts",
				"file1.ts",
			]);
			const large = await warmThenRebuildFiles(makeRing(64), [
				"file0.ts",
				"file1.ts",
			]);

			// Sanity: the fixture really did scale, so an O(graph) cost would show.
			expect(large.nodes).toBeGreaterThan(small.nodes * 3);
			expect(large.edges).toBeGreaterThan(small.edges * 3);

			expect(large.counters.removeOwnedEdgeVisits).toBe(
				small.counters.removeOwnedEdgeVisits,
			);
		},
	);

	it(
		"removes a high-fan-in target with one adjacency-bucket pass",
		{ timeout: 240_000 },
		async () => {
			const small = await warmThenRebuildOneFile(makeFanIn(200), "target.ts");
			const large = await warmThenRebuildOneFile(makeFanIn(400), "target.ts");

			// These are real graph builds. The changed target owns the shared symbol,
			// so its incoming bucket contains every caller edge. Pin that precondition
			// independently before comparing the bucket-removal work counter.
			expect(maxCallFanIn(small.graph)).toBeGreaterThanOrEqual(200);
			expect(maxCallFanIn(large.graph)).toBeGreaterThanOrEqual(400);
			expect(large.counters.removeOwnedEdgePositions).toBeGreaterThan(0);
			expect(large.counters.removeOwnedEdgePositions).toBeLessThan(
				small.counters.removeOwnedEdgePositions * 3,
			);
		},
	);

	it(
		"reports existedBefore and leaves every derived index intact",
		{ timeout: 120_000 },
		async () => {
			const probe = await warmThenRebuildOneFile(makeRing(10));
			const delta = getGraphImportChanges(probe.graph);
			expect(delta).toBeDefined();
			const change = delta?.changes.find((entry) =>
				entry.filePath.endsWith("file0.ts"),
			);
			expect(change).toBeDefined();
			// updateGraphFiles used to read existedBefore off the EMPTY fileNodes map
			// a fresh cloneGraph hands it, so a long-standing file always looked new.
			// clients/dispatch/integration.ts:1077 reads this to decide whether the
			// reverse-dependency index can be reused; a false negative here forces a
			// full reverse-deps rebuild on every incremental build.
			expect(change?.existedBefore).toBe(true);
			expect(change?.existsAfter).toBe(true);

			// Mutation guard for the incremental index maintenance that replaced the
			// terminal rebuildIndexes: dropping unindexEdge, addNode's
			// symbolNodesByFile upkeep, or resolveDeferredSymbolEdges' replacement
			// patching all leave the live indexes disagreeing with this reference.
			expect(liveIndexes(probe.graph)).toEqual(referenceIndexes(probe.graph));
			expect(probe.graph.edgesByFrom.size).toBeGreaterThan(0);
		},
	);

	it(
		"orders resolved-edge buckets the way a full reindex would",
		{ timeout: 120_000 },
		async () => {
			// `aaa-caller` and `bbb-caller` call `shared()` by bare name. Two files
			// define `shared`, so both calls stay on the unresolved placeholder and
			// their edges sit EARLY in graph.edges. Renaming one definer makes the
			// name unique, so resolveDeferredSymbolEdges moves those long-standing
			// early edges into `zzz-def`'s symbol bucket, which already holds a
			// LATER `contains` edge.
			//
			// Appending to the bucket puts them in the wrong order. That is
			// observable: `resolveUsedBy` in clients/module-report.ts walks
			// `edgesByTo` and truncates at a cap, so bucket order decides which
			// callers a reader is shown. This assertion reds if the patch in
			// resolveDeferredSymbolEdges goes back to unindex-then-append.
			const root = makeProject({
				"src/aaa-caller.ts":
					"export function callsIt(): number {\n\treturn shared();\n}\n",
				"src/bbb-caller.ts":
					"export function callsItToo(): number {\n\treturn shared();\n}\n",
				"src/mmm-dup.ts":
					"export function shared(): number {\n\treturn 2;\n}\n",
				"src/zzz-def.ts":
					"export function shared(): number {\n\treturn 1;\n}\n",
			});
			const changed = path.join(root, "src", "mmm-dup.ts");
			let seq = 0;
			const seqHint = {
				projectSeq: () => seq,
				getFilesChangedSince: () => [changed],
			};
			await buildOrUpdateGraph(root, [changed], new FactStore(), seqHint);
			seq++;
			fs.writeFileSync(
				changed,
				"export function renamedAway(): number {\n\treturn 2;\n}\n",
			);
			clearGraphCache();
			const graph = await buildOrUpdateGraph(
				root,
				[changed],
				new FactStore(),
				seqHint,
			);

			// Precondition: the rename really did resolve previously-ambiguous
			// edges, so the ordering path under test actually ran.
			const resolved = graph.edges.filter(
				(edge) => edge.kind === "calls" && edge.resolution === "exact",
			);
			expect(resolved.length).toBeGreaterThan(0);

			expect(liveIndexes(graph)).toEqual(referenceIndexes(graph));
		},
	);

	it(
		"collapses a duplicate incoming edge left by a same-batch rebuild",
		{ timeout: 120_000 },
		async () => {
			// This is the fixture that actually reaches the dedupe branch in
			// restoreValidIncomingEdges. Re-extracting two mutually-referencing
			// files in ONE batch leaves a duplicate `calls` edge: the preserved
			// incoming edge already points at the real symbol, while the freshly
			// extracted one points at a placeholder that resolveDeferredSymbolEdges
			// rewrites onto that same symbol AFTER the restore has run. That
			// duplicate is pre-existing behavior, reproduces on master, and is
			// tracked as #2127.
			//
			// The next single-file rebuild is where the dedupe branch earns its
			// place: both copies come back as preserved incoming edges, and the
			// branch collapses them. Delete `if (seen.has(key)) continue;` and this
			// rebuild leaves the duplicate in place instead of repairing it.
			const root = makeProject({
				"src/a.ts":
					'import { fnB } from "./b.js";\nexport function fnA(): number {\n\treturn fnB();\n}\n',
				"src/b.ts":
					'import { fnA } from "./a.js";\nexport function fnB(): number {\n\treturn fnA();\n}\n',
			});
			const fileA = path.join(root, "src", "a.ts");
			const fileB = path.join(root, "src", "b.ts");
			let seq = 0;
			let changedNow: string[] = [fileA];
			const seqHint = {
				projectSeq: () => seq,
				getFilesChangedSince: () => changedNow,
			};
			const cold = await buildOrUpdateGraph(
				root,
				changedNow,
				new FactStore(),
				seqHint,
			);
			expect(duplicateEdgeCount(cold)).toBe(0);
			const coldEdges = cold.edges.length;

			// Same-batch re-extraction of both files must not retain a duplicate.
			seq++;
			changedNow = [fileA, fileB];
			for (const file of changedNow) {
				fs.appendFileSync(file, "\nexport const batchMarker = 1;\n");
			}
			clearGraphCache();
			const batched = await buildOrUpdateGraph(
				root,
				changedNow,
				new FactStore(),
				seqHint,
			);
			expect(duplicateEdgeCount(batched)).toBe(0);
			expect(batched.edges.length).toBe(coldEdges);

			// A later single-file rebuild remains duplicate-free. This also guards
			// the existing restore dedupe branch and its bounded repair behavior.
			seq++;
			changedNow = [fileA];
			fs.appendFileSync(fileA, "\nexport const singleMarker = 2;\n");
			clearGraphCache();
			const repaired = await buildOrUpdateGraph(
				root,
				changedNow,
				new FactStore(),
				seqHint,
			);
			expect(duplicateEdgeCount(repaired)).toBe(0);
			expect(repaired.edges.length).toBe(coldEdges);
		},
	);

	it(
		"does not duplicate preserved incoming edges across repeated rebuilds",
		{ timeout: 120_000 },
		async () => {
			const root = makeRing(10);
			const changed = path.join(root, "src", "file0.ts");
			let seq = 0;
			const seqHint = {
				projectSeq: () => seq,
				getFilesChangedSince: () => [changed],
			};
			await buildOrUpdateGraph(root, [changed], new FactStore(), seqHint);
			let previousEdges = -1;
			for (let round = 0; round < 3; round++) {
				seq++;
				fs.appendFileSync(
					changed,
					`\nexport const marker${round} = ${round};\n`,
				);
				clearGraphCache();
				const graph = await buildOrUpdateGraph(
					root,
					[changed],
					new FactStore(),
					seqHint,
				);
				// Mutation guard for the dedupe branch in restoreValidIncomingEdges:
				// dropping it re-appends the preserved incoming edges every round, so
				// the edge count climbs instead of holding steady.
				const keys = graph.edges.map((edge) =>
					JSON.stringify([edge.from, edge.to, edge.kind, edge.metadata ?? {}]),
				);
				expect(new Set(keys).size).toBe(keys.length);
				if (previousEdges >= 0) expect(graph.edges.length).toBe(previousEdges);
				previousEdges = graph.edges.length;
			}
		},
	);
});
