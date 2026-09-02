/**
 * #958 durable word-index observability — asserts the structured signals the
 * audit flagged as missing are EMITTED at their source (independent of the
 * host's `dbg`, which is a no-op in the MCP host):
 *   - L1: `collectWordIndexDocs` reports a `skipped` count for files it saw but
 *     could not index (over the byte cap / unreadable), so coverage stays
 *     honest (#533) instead of a silent drop.
 *   - M2: the cold-query background build logs its decision + coverage
 *     (indexedFileCount / truncated / skipped).
 *   - M3: a swallowed snapshot persist emits a `persist_failed` record.
 *   - The safety refusal (root at/above $HOME) is durably recorded too.
 *
 * `logWordIndex` is mocked with a spy so the assertions read the exact entries
 * the production code hands the durable logger, without touching disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
const { failPersist } = vi.hoisted(() => ({ failPersist: { value: false } }));

vi.mock("../../clients/word-index-logger.js", () => ({
	logWordIndex: logSpy,
	getWordIndexLogPath: () => "/dev/null/word-index.log",
	flushWordIndexLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../clients/project-snapshot.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/project-snapshot.js")>();
	return {
		...actual,
		default: actual,
		saveProjectSnapshot: (...args: unknown[]) => {
			if (failPersist.value) throw new Error("ENOSPC: no space left on device");
			return (actual.saveProjectSnapshot as (...a: unknown[]) => unknown)(
				...args,
			);
		},
	};
});

beforeEach(() => {
	logSpy.mockClear();
	failPersist.value = false;
	process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "0";
	// The persist merges into the project snapshot, whose body write defaults to
	// a worker thread (#958 item 2); force the sync writer so a successful
	// persist test doesn't leave a worker handle open (this suite tests the
	// word-index log, not the snapshot offload).
	process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
});
afterEach(async () => {
	const { flushWordIndexPersistsForTests, _resetWordIndexBuildGuardForTests } =
		await import("../../clients/word-index.js");
	flushWordIndexPersistsForTests();
	_resetWordIndexBuildGuardForTests();
	delete process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS;
	delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	vi.restoreAllMocks();
});

describe("word-index observability (#958)", () => {
	it("L1: collectWordIndexDocs counts oversized + unreadable files as skipped, keeping coverage honest", async () => {
		const env = setupTestEnvironment("pi-lens-word-skip-");
		try {
			const { collectWordIndexDocs, WORD_INDEX_MAX_BYTES } =
				await import("../../clients/word-index.js");
			createTempFile(env.tmpDir, "src/small.ts", "export const kept = 1;");
			// The oversized fixture must stay HUMAN-shaped: many ordinary lines,
			// not one giant line. Since #2346 a giant single-line file classifies
			// as machine-emitted generated and is pruned at the source walk, so
			// the oversized-skip accounting below would otherwise see nothing to
			// count. A many-line >cap file still exercises the L1 contract.
			const bodyLine = `export const data = "${"x".repeat(48)}";`;
			const hugeBody = Array.from(
				{
					length: Math.ceil((WORD_INDEX_MAX_BYTES + 16) / bodyLine.length),
				},
				(_, i) => `// section ${i}\n${bodyLine}`,
			).join("\n");
			createTempFile(env.tmpDir, "src/huge.ts", `// x\n${hugeBody}\n`);

			const docs = await collectWordIndexDocs(env.tmpDir);

			// The small file is indexed; the oversized file is NOT — but it is
			// COUNTED, not silently dropped.
			expect(docs.some((d) => d.path.endsWith("small.ts"))).toBe(true);
			expect(docs.some((d) => d.path.endsWith("huge.ts"))).toBe(false);
			expect(docs.skipped).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("M3: a swallowed persist failure emits a persist_failed record (every later query would read stale)", async () => {
		const env = setupTestEnvironment("pi-lens-word-persist-fail-");
		try {
			const {
				buildWordIndex,
				scheduleWordIndexPersist,
				flushWordIndexPersistsForTests,
			} = await import("../../clients/word-index.js");
			const index = buildWordIndex([
				{ path: "a.ts", content: "export const alpha = 1;" },
			]);

			failPersist.value = true;
			scheduleWordIndexPersist(env.tmpDir, index);
			flushWordIndexPersistsForTests();
			await vi.waitFor(() =>
				expect(
					logSpy.mock.calls.some((c) => c[0]?.phase === "persist_failed"),
				).toBe(true),
			);

			const persistFailed = logSpy.mock.calls.find(
				(c) => c[0]?.phase === "persist_failed",
			);
			expect(persistFailed).toBeDefined();
			expect(persistFailed?.[0]).toEqual(
				expect.objectContaining({
					phase: "persist_failed",
					trigger: "per_edit",
					indexedFileCount: 1,
					error: expect.stringContaining("ENOSPC"),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("F1: a successful debounced persist emits a persist_succeeded record (the MCP-host freshness signal the old dbg adapter provided)", async () => {
		const env = setupTestEnvironment("pi-lens-word-persist-ok-");
		try {
			const {
				buildWordIndex,
				updateWordIndexDocument,
				scheduleWordIndexPersist,
				flushWordIndexPersistsForTests,
			} = await import("../../clients/word-index.js");
			const index = buildWordIndex([
				{ path: "a.ts", content: "export const alpha = 1;" },
			]);
			updateWordIndexDocument(index, {
				path: "a.ts",
				content: "export const alpha = 2;",
			});

			scheduleWordIndexPersist(env.tmpDir, index);
			flushWordIndexPersistsForTests();
			await vi.waitFor(() =>
				expect(
					logSpy.mock.calls.some(
						(c) =>
							c[0]?.phase === "persist_succeeded" && c[0]?.cwd === env.tmpDir,
					),
				).toBe(true),
			);

			const ok = logSpy.mock.calls.find(
				(c) => c[0]?.phase === "persist_succeeded" && c[0]?.cwd === env.tmpDir,
			);
			expect(ok).toBeDefined();
			expect(ok?.[0]).toEqual(
				expect.objectContaining({
					phase: "persist_succeeded",
					trigger: "per_edit",
					indexedFileCount: 1,
					tokens: expect.any(Number),
					postingEntries: expect.any(Number),
					replacementCount: 1,
					totalReplacementMs: expect.any(Number),
					maxReplacementMs: expect.any(Number),
				}),
			);
			// And no persist_failed on the success path.
			expect(
				logSpy.mock.calls.find((c) => c[0]?.phase === "persist_failed"),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("records bounded arena recompaction measurements", async () => {
		const env = setupTestEnvironment("pi-lens-word-recompact-log-");
		try {
			const {
				buildWordIndex,
				flushWordIndexRecompactionsForTests,
				updateWordIndexDocument,
			} = await import("../../clients/word-index.js");
			const index = buildWordIndex(
				Array.from({ length: 70 }, (_, file) => ({
					path: `${env.tmpDir}/f${file}.ts`,
					content: `sharedToken stableToken${file}`,
				})),
			);
			for (let file = 0; file < 70; file += 1) {
				updateWordIndexDocument(index, {
					path: `${env.tmpDir}/f${file}.ts`,
					content: `sharedToken changedToken${file} revision`,
				});
			}
			await flushWordIndexRecompactionsForTests(index);
			expect(logSpy.mock.calls).toContainEqual([
				expect.objectContaining({
					phase: "incremental_refresh",
					trigger: "incremental_refresh",
					reason: expect.stringMatching(
						/^arena_recompact beforeBytes=\d+ afterBytes=\d+ beforeStores=\d+ afterStores=1$/,
					),
				}),
			]);
		} finally {
			env.cleanup();
		}
	});

	it("records them for the per-edit seam's cooperative primitive too", async () => {
		const env = setupTestEnvironment("pi-lens-word-recompact-async-");
		try {
			const {
				buildWordIndex,
				flushWordIndexRecompactionsForTests,
				updateWordIndexDocumentForEdit,
			} = await import("../../clients/word-index.js");
			const index = buildWordIndex(
				Array.from({ length: 70 }, (_, file) => ({
					path: `${env.tmpDir}/f${file}.ts`,
					content: `sharedToken stableToken${file}`,
				})),
			);
			for (let file = 0; file < 70; file += 1) {
				expect(
					await updateWordIndexDocumentForEdit(index, {
						path: `${env.tmpDir}/f${file}.ts`,
						content: `sharedToken changedToken${file} revision`,
					}),
				).toBe(true);
			}
			await flushWordIndexRecompactionsForTests(index);
			expect(logSpy.mock.calls).toContainEqual([
				expect.objectContaining({
					phase: "incremental_refresh",
					trigger: "incremental_refresh",
					reason: expect.stringMatching(
						/^arena_recompact beforeBytes=\d+ afterBytes=\d+ beforeStores=\d+ afterStores=1$/,
					),
				}),
			]);
		} finally {
			env.cleanup();
		}
	});

	it("resets replacementCount between successful persist records", async () => {
		const env = setupTestEnvironment("pi-lens-word-replacement-reset-");
		try {
			const {
				buildWordIndex,
				updateWordIndexDocument,
				scheduleWordIndexPersist,
				flushWordIndexPersistsForTests,
			} = await import("../../clients/word-index.js");
			const index = buildWordIndex([{ path: "a.ts", content: "alpha" }]);
			updateWordIndexDocument(index, { path: "a.ts", content: "beta" });
			scheduleWordIndexPersist(env.tmpDir, index);
			flushWordIndexPersistsForTests();
			await vi.waitFor(() =>
				expect(
					logSpy.mock.calls.filter(
						(c) =>
							c[0]?.phase === "persist_succeeded" && c[0]?.cwd === env.tmpDir,
					).length,
				).toBe(1),
			);
			scheduleWordIndexPersist(env.tmpDir, index);
			flushWordIndexPersistsForTests();
			await vi.waitFor(() =>
				expect(
					logSpy.mock.calls.filter(
						(c) =>
							c[0]?.phase === "persist_succeeded" && c[0]?.cwd === env.tmpDir,
					).length,
				).toBe(2),
			);
			const records = logSpy.mock.calls
				.map((call) => call[0])
				.filter(
					(record) =>
						record?.phase === "persist_succeeded" && record?.cwd === env.tmpDir,
				);
			expect(records).toHaveLength(2);
			expect(records[1]).toEqual(
				expect.objectContaining({ replacementCount: 0 }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("M2: the cold-query background build logs its decision + honest coverage", async () => {
		const env = setupTestEnvironment("pi-lens-word-cold-");
		try {
			createTempFile(
				env.tmpDir,
				"src/widget.ts",
				"export const renderWidget = 1;",
			);
			const { triggerBackgroundWordIndexBuild } =
				await import("../../clients/word-index.js");

			triggerBackgroundWordIndexBuild(env.tmpDir);
			await vi.waitFor(() =>
				expect(
					logSpy.mock.calls.some((c) => c[0]?.phase === "cold_build"),
				).toBe(true),
			);

			const coldBuild = logSpy.mock.calls.find(
				(c) => c[0]?.phase === "cold_build",
			);
			expect(coldBuild).toBeDefined();
			expect(coldBuild?.[0]).toEqual(
				expect.objectContaining({
					phase: "cold_build",
					trigger: "cold_query",
					truncated: false,
					skipped: 0,
				}),
			);
			expect(coldBuild?.[0].indexedFileCount).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("records the safety refusal when the root is at/above $HOME", async () => {
		const env = setupTestEnvironment("pi-lens-word-refused-");
		try {
			const { triggerBackgroundWordIndexBuild } =
				await import("../../clients/word-index.js");
			// homeDir == the build root ⇒ isAtOrAboveHomeDir refuses.
			const status = triggerBackgroundWordIndexBuild(env.tmpDir, undefined, {
				homeDir: env.tmpDir,
			});

			expect(status.state).toBe("refused");
			const refused = logSpy.mock.calls.find(
				(c) => c[0]?.phase === "cold_build_refused",
			);
			expect(refused).toBeDefined();
			expect(refused?.[0]).toEqual(
				expect.objectContaining({
					phase: "cold_build_refused",
					trigger: "cold_query",
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});
