/**
 * Event-loop occupancy guard for the per-edit cascade graph rebuild.
 *
 * `buildOrUpdateGraph` runs on EVERY write/edit (via `computeCascadeForFile` in
 * the per-edit pipeline). Even on a pure cache hit it must re-derive the
 * workspace source-file list and its size/mtime signature to validate the
 * cached graph — which means walking the whole project tree and statting every
 * source file. On a ~1,200-file project that synchronous burst measured ~790ms
 * (it froze pi's TUI for ~0.8s on every keystroke-triggered edit) before this
 * was made async + chunked-yield.
 *
 * This is the CI trip-wire that would catch a regression back to a non-yielding
 * walk/stat on the per-edit path. We measure event-loop occupancy (longest sync
 * block), NOT wall-clock duration — the total FS work is unchanged; what must
 * stay bounded is the longest stretch the loop is held.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import { patchReverseDependencyIndex } from "../../clients/reverse-deps.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import { computeImpactCascade } from "../../clients/review-graph/query.js";
import type { ReviewGraph } from "../../clients/review-graph/types.js";
import {
	generateSourceTree,
	measureMaxSyncBlockMs,
} from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

// The async walk/stat yields every chunk, so its longest real sync block is
// ~17-36ms at 1200 files (measured both standalone and inside vitest). The
// regression we guard against — a non-yielding walk + per-file stat — does
// ~770ms+ of synchronous work at this scale, so 300ms catches it with a wide
// margin while absorbing ambient parallel-suite load. retry soaks rare spikes.
// NB: tests run against the COMPILED .js (npm run build emits in-place and
// vitest resolves the `.js` specifier to it), so a source change only takes
// effect after a rebuild — CI builds before `npm test`.
const MAX_SYNC_BLOCK_MS = 300;
// ~1,200 files makes a non-yielding regression blow the budget (~0.8s ≫ 300ms)
// while keeping the fixture light enough not to starve other parallel tests.
const TREE_SIZE = 1200;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cascade-occupancy-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

beforeEach(() => {
	// Force a cold per-invocation cache so each measurement re-derives the
	// source-file list + signature (the dominant per-edit cost we hardened).
	clearGraphCache();
	_resetGeneratedArtifactCaches();
});

describe(`cascade graph rebuild event-loop occupancy (~${TREE_SIZE} files)`, () => {
	it(
		"cold buildOrUpdateGraph stays under the sync-block budget",
		{ retry: 2, timeout: 60_000 },
		async () => {
			clearReviewGraphWorkspaceCache();
			const facts = new FactStore();
			const changed = [path.join(tmpDir, "src", "file0.ts")];
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				await buildOrUpdateGraph(tmpDir, changed, facts);
			});
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);

	it(
		"warm (cache-hit) buildOrUpdateGraph stays under the sync-block budget",
		{ retry: 2, timeout: 60_000 },
		async () => {
			const facts = new FactStore();
			const changed = [path.join(tmpDir, "src", "file0.ts")];
			// Prime the workspace cache so this run is a pure cache hit — the exact
			// per-edit scenario where the signature re-derivation dominates.
			await buildOrUpdateGraph(tmpDir, changed, facts);
			clearGraphCache();
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				await buildOrUpdateGraph(tmpDir, changed, facts);
			});
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);

	it(
		"main-thread reverse-dependency delta patch stays under the sync-block budget",
		{ retry: 2, timeout: 60_000 },
		async () => {
			const index = {
				projectRoot: tmpDir,
				generatedAt: new Date().toISOString(),
				imports: Object.fromEntries(
					Array.from({ length: 200 }, (_, i) => [`file-${i}.ts`, []]),
				),
				importedBy: {},
				source: "review-graph" as const,
			};
			const changes = Array.from({ length: 200 }, (_, i) => ({
				filePath: path.join(tmpDir, `file-${i}.ts`),
				priorTargets: [],
				newTargets: [path.join(tmpDir, `dependency-${i}.ts`)],
				existedBefore: true,
				existsAfter: true,
			}));
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				patchReverseDependencyIndex(index, changes);
			});
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);

	it(
		"main-thread impact-cascade traversal stays under the sync-block budget",
		{ retry: 2, timeout: 60_000 },
		async () => {
			const graph = emptyGraph();
			const seed = path.join(tmpDir, "seed.ts");
			const seedNode = "file:seed";
			graph.nodes.set(seedNode, {
				id: seedNode,
				kind: "file",
				language: "typescript",
				filePath: seed,
			});
			graph.fileNodes.set(seed, seedNode);
			for (let i = 0; i < 10_000; i++) {
				const nodeId = `file:dependent-${i}`;
				const file = path.join(tmpDir, `dependent-${i}.ts`);
				graph.nodes.set(nodeId, {
					id: nodeId,
					kind: "file",
					language: "typescript",
					filePath: file,
				});
				graph.edges.push({ from: nodeId, to: seedNode, kind: "imports" });
			}
			graph.edgesByTo.set(seedNode, graph.edges);
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				computeImpactCascade(graph, seed);
			});
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);
});

function emptyGraph(): ReviewGraph {
	return {
		version: "v8",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}
