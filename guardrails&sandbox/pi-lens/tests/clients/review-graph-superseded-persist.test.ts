/**
 * #1318 SLICE 1 — INVARIANT LOCK for worker-generation promotion.
 *
 * The first build is suspended at the real cooperative setImmediate seam.
 * The continuation starts generation 2 before generation 1 resumes, while a
 * worker delay keeps generation 1's staged result in flight.  Only generation
 * 2 may become the authoritative snapshot; the stale stage and its atomic
 * write namespace must be cleaned up.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STAGE_TMP_PATTERN } from "../../clients/atomic-write-staging.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getReviewGraphWorkerFallbackReasonForTests,
	reviewGraphCachePath,
	resetReviewGraphPersistWorkerForTests,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { gunzipSync } from "node:zlib";

const dirs: string[] = [];

afterEach(async () => {
	flushReviewGraphPersistsForTests();
	await waitForReviewGraphPersistsForTests();
	resetReviewGraphPersistWorkerForTests();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("review-graph worker supersession (#1318)", () => {
	it(
		"never promotes a superseded generation or exposes partial state",
		{ timeout: 60_000 },
		async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-graph-lock-"));
			dirs.push(cwd);
			const oldFiles = Array.from({ length: 150 }, (_, i) => {
				const file = path.join(cwd, "src", `old-${i}.ts`);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, `export const oldGeneration${i} = ${i};\n`);
				return file;
			});
			const newerFile = path.join(cwd, "src", "new-generation.ts");
			const facts = new FactStore();
			vi.stubEnv("PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS", "0");
			vi.stubEnv("PI_LENS_TEST_PERSIST_WORKER_DELAY_MS", "400");

			const first = await buildOrUpdateGraph(cwd, oldFiles, facts);
			expect(getReviewGraphWorkerFallbackReasonForTests()).toBeUndefined();
			// Generation 1 is now suspended in the delayed worker write. Start
			// generation 2 from the next setImmediate callback, deterministically,
			// while generation 1 remains in flight.
			const realSetImmediate = globalThis.setImmediate;
			let secondBuild: ReturnType<typeof buildOrUpdateGraph> | undefined;
			vi.spyOn(globalThis, "setImmediate").mockImplementation(
				(callback, ...args) => {
					if (!secondBuild) {
						fs.writeFileSync(
							newerFile,
							"export const newerGenerationObservable = true;\n",
						);
						vi.stubEnv("PI_LENS_TEST_PERSIST_WORKER_DELAY_MS", "0");
						clearReviewGraphWorkspaceCache();
						clearGraphCache();
						secondBuild = buildOrUpdateGraph(cwd, [newerFile], facts);
					}
					return realSetImmediate(callback, ...args);
				},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const second = await secondBuild!;
			expect(first.nodes.size).toBeGreaterThan(0);
			expect(second.buildGeneration).not.toBe(first.buildGeneration);
			expect([...second.fileNodes.keys()]).toContain(
				newerFile.replaceAll("\\", "/"),
			);

			await waitForReviewGraphPersistsForTests();
			await new Promise<void>((resolve) => realSetImmediate(resolve));
			const cachePath = reviewGraphCachePath(cwd);
			const persisted = JSON.parse(
				gunzipSync(fs.readFileSync(cachePath)).toString("utf8"),
			) as {
				builtAt: string;
				nodes: Array<[string, { filePath?: string }]>;
			};
			const persistedFiles = persisted.nodes
				.map(([, node]) => node.filePath)
				.filter((file): file is string => file !== undefined);
			expect(new Set(persistedFiles)).toEqual(new Set(second.fileNodes.keys()));
			// The authoritative payload has no buildGeneration field; its file set is
			// the observable replacement, while the in-memory generation proves the
			// two builds were distinct.

			const cacheDir = path.dirname(cachePath);
			const leftovers = fs
				.readdirSync(cacheDir)
				.filter(
					(name) => name.includes(".stage-") || STAGE_TMP_PATTERN.test(name),
				);
			expect(leftovers).toEqual([]);
			// The data directory is resolved from the same cwd on every OS; this
			// read also ensures the assertion inspected the project-scoped cache.
			expect(path.dirname(cacheDir)).toBe(getProjectDataDir(cwd));
		},
	);
});
