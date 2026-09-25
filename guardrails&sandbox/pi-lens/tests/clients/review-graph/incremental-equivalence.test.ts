import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	_getReviewGraphCacheStateForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function canonicalize(value: unknown, root: string): unknown {
	const normalizedRoot = root.replaceAll("\\", "/");
	return JSON.parse(
		JSON.stringify(value, (_key, nested) =>
			typeof nested === "string"
				? nested.replaceAll(root, "<root>").replaceAll(normalizedRoot, "<root>")
				: nested,
		),
	) as unknown;
}

function sortedMap<T>(map: Map<string, T>): Array<[string, T]> {
	return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function graphShape(graph: ReviewGraph, root: string): unknown {
	const nodes = sortedMap(graph.nodes);
	const edges = [...graph.edges].sort((a, b) =>
		JSON.stringify(a).localeCompare(JSON.stringify(b)),
	);
	const sortedIndex = <T>(map: Map<string, T[]>): Array<[string, T[]]> =>
		sortedMap(
			new Map(
				[...map].map(([key, values]) => [
					key,
					[...values].sort((a, b) =>
						JSON.stringify(a).localeCompare(JSON.stringify(b)),
					),
				]),
			),
		);
	const indexes = {
		edgesByFrom: sortedIndex(graph.edgesByFrom),
		edgesByTo: sortedIndex(graph.edgesByTo),
		fileNodes: sortedMap(graph.fileNodes),
		symbolNodesByFile: sortedIndex(graph.symbolNodesByFile),
		changedSymbolsByFile: sortedIndex(graph.changedSymbolsByFile),
	};
	return canonicalize({ nodes, edges, indexes }, root);
}

function cacheShape(root: string): unknown {
	const cached = _getReviewGraphCacheStateForTests(root);
	if (!cached) return undefined;
	return canonicalize(
		{
			signature: cached.signature,
			fileSignatures: sortedMap(cached.fileSignatures),
			fileHashes: sortedMap(cached.fileHashes ?? new Map()),
		},
		root,
	);
}

function writeState(
	root: string,
	state: ReadonlyMap<string, string>,
	mtimeMs: number,
): void {
	const expected = new Set(
		[...state.keys()].map((relative) => path.join(root, relative)),
	);
	for (const existing of fs.readdirSync(root, { recursive: true })) {
		const file = path.join(root, String(existing));
		if (file.endsWith(".ts") && !expected.has(file)) fs.rmSync(file);
	}
	for (const [relative, content] of state) {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		const time = new Date(mtimeMs);
		fs.utimesSync(file, time, time);
	}
}

function writeChanges(
	root: string,
	state: ReadonlyMap<string, string>,
	changed: readonly string[],
	mtimeMs: number,
): void {
	for (const relative of changed) {
		const file = path.join(root, relative);
		const content = state.get(relative);
		if (content === undefined) {
			if (fs.existsSync(file)) fs.rmSync(file);
			continue;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		const time = new Date(mtimeMs);
		fs.utimesSync(file, time, time);
	}
}

describe("review-graph incremental/full-build equivalence (#939)", () => {
	// The "rebuilt from scratch" reference must NOT silently take the
	// incremental path: if a debounced persist flushes mid-test, the next
	// "full" build hits the disk tier and reuses updateGraphFiles — the same
	// code under test, so a systematic bug would diverge both sides
	// identically and the comparison would pass (#939 review finding 2).
	// Pushing the debounce past the test lifetime keeps the reference honest.
	beforeAll(() => {
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
	});
	afterAll(() => {
		delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
	});

	for (const seed of [93901, 93902, 93903]) {
		it(
			`matches nodes, edges, indexes, and signatures for seed ${seed}`,
			{
				timeout: 120_000,
			},
			async () => {
				let randomState = seed;
				const random = () => {
					randomState = (Math.imul(randomState, 1_103_515_245) + 12_345) >>> 0;
					return randomState / 0x1_0000_0000;
				};
				// Both arms share ONE mkdtemp'd parent with fixed subpaths (rather
				// than two independent mkdtemp roots) so their absolute paths can
				// never diverge in length/shape — cheap defense-in-depth against any
				// future path-derived metadata leaking a difference between the
				// incremental and full-rebuild arms. The actual root cause (a
				// feature-hint classifier reading the absolute temp path) is already
				// fixed at the source (#962/#972); this only guards against a
				// regression reintroducing that class of bug.
				const pairRoot = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-inc-eq-"),
				);
				const incrementalRoot = path.join(pairRoot, "incremental");
				const fullRoot = path.join(pairRoot, "full");
				fs.mkdirSync(incrementalRoot, { recursive: true });
				fs.mkdirSync(fullRoot, { recursive: true });
				roots.push(pairRoot);
				const state = new Map<string, string>([
					["src/a.ts", "export const alpha = 1;\n"],
					[
						"src/b.ts",
						"import { alpha } from './a';\nexport const beta = alpha;\n",
					],
					[
						"src/c.ts",
						"import { beta } from './b';\nexport const gamma = beta;\n",
					],
					["src/d.ts", "export function delta() { return 4; }\n"],
				]);
				let seq = 0;
				let changed = [...state.keys()];
				const mtimeBase = 1_900_000_000_000 + seed * 1_000;
				writeState(incrementalRoot, state, mtimeBase);
				writeState(fullRoot, state, mtimeBase);
				const seqHint = {
					projectSeq: () => seq,
					getFilesChangedSince: () =>
						changed.map((relative) => path.join(incrementalRoot, relative)),
				};
				clearGraphCache();
				await buildOrUpdateGraph(
					incrementalRoot,
					changed.map((relative) => path.join(incrementalRoot, relative)),
					new FactStore(),
					seqHint,
				);
				clearGraphCache();
				await buildOrUpdateGraph(
					fullRoot,
					changed.map((relative) => path.join(fullRoot, relative)),
					new FactStore(),
				);

				for (let step = 0; step < 10; step++) {
					const operation = step % 5;
					const active = [...state.keys()].sort();
					if (operation === 0) {
						const relative = active[Math.floor(random() * active.length)];
						state.set(
							relative,
							`${state.get(relative)}\nexport const body${step} = ${step};\n`,
						);
						changed = [relative];
					} else if (operation === 1) {
						const relative = `src/added-${step}.ts`;
						state.set(
							relative,
							"import { alpha } from './a';\nexport const added = alpha;\n",
						);
						changed = [relative];
					} else if (operation === 2) {
						const relative = active.find((file) => file.includes("added-"));
						if (relative) state.delete(relative);
						changed = relative ? [relative] : ["src/d.ts"];
					} else if (operation === 3) {
						state.set(
							"src/c.ts",
							"import { alpha } from './a';\nexport function gamma() { return alpha; }\n",
						);
						changed = ["src/c.ts"];
					} else {
						state.set("src/a.ts", `export const alpha${step} = ${step};\n`);
						state.set(
							"src/b.ts",
							`import { alpha${step} } from './a';\nexport const beta${step} = alpha${step};\n`,
						);
						changed = ["src/a.ts", "src/b.ts"];
					}
					seq++;
					const mtime = mtimeBase + seq * 2_000;
					writeChanges(incrementalRoot, state, changed, mtime);
					writeChanges(fullRoot, state, changed, mtime);

					clearGraphCache();
					const incremental = await buildOrUpdateGraph(
						incrementalRoot,
						changed.map((relative) => path.join(incrementalRoot, relative)),
						new FactStore(),
						seqHint,
					);
					clearReviewGraphWorkspaceCache(fullRoot);
					const rebuilt = await buildOrUpdateGraph(
						fullRoot,
						changed.map((relative) => path.join(fullRoot, relative)),
						new FactStore(),
					);

					expect(graphShape(incremental, incrementalRoot)).toEqual(
						graphShape(rebuilt, fullRoot),
					);
					expect(cacheShape(incrementalRoot)).toEqual(cacheShape(fullRoot));
				}
			},
		);
	}
});
