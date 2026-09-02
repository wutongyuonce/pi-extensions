/**
 * #348 phase 1 — the word index's load -> rebuild-if-stale -> persist
 * lifecycle, given the same shape the call-graph task already uses:
 *   - absent snapshot -> full bounded rebuild + persist
 *   - stale snapshot (seq mismatch) -> rebuild + persist
 *   - fresh snapshot -> reuse (no rebuild)
 * and the quick-mode cold-start warmup pass building/persisting the index too
 * (decision 2: fold into the existing warmup, not a new mechanism).
 */

import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loadProjectSnapshot,
	PROJECT_SNAPSHOT_VERSION,
	getProjectSnapshotPath,
	saveProjectSnapshot,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import {
	buildWordIndex,
	serializeWordIndex,
} from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Same LSP stub as runtime-session.test.ts / runtime-session-warm.test.ts: the
// dominant-language auto-warm (#203) must not spawn a real language server
// against a throwaway temp dir.
const mockTouchFile = vi.fn(async () => undefined);
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(() => ({
		supportsLSP: () => false,
		touchFile: mockTouchFile,
	})),
}));

const deferredRuntimeSnapshotSave = vi.hoisted(() => ({
	delayCall: undefined as number | undefined,
	calls: 0,
	wordIndexSaveCompleted: false,
	delayMs: 1200,
}));
vi.mock("../../clients/project-snapshot.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/project-snapshot.js")>();
	return {
		...actual,
		saveRuntimeProjectSnapshot: vi.fn((args) => {
			// Replace the old ordinal assumption ("the second save is the
			// promotion") with the free content discriminator: only a save carrying
			// the runtime word index belongs to this forcing/barrier.
			deferredRuntimeSnapshotSave.calls += 1;
			const carriesWordIndex = args.runtime.wordIndex !== null;
			if (!carriesWordIndex) {
				actual.saveRuntimeProjectSnapshot(args);
				return;
			}
			if (
				deferredRuntimeSnapshotSave.calls !==
				deferredRuntimeSnapshotSave.delayCall
			) {
				actual.saveRuntimeProjectSnapshot(args);
				deferredRuntimeSnapshotSave.wordIndexSaveCompleted = true;
				return;
			}
			deferredRuntimeSnapshotSave.delayCall = undefined;
			setTimeout(() => {
				actual.saveRuntimeProjectSnapshot(args);
				deferredRuntimeSnapshotSave.wordIndexSaveCompleted = true;
			}, deferredRuntimeSnapshotSave.delayMs).unref();
		}),
	};
});

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

async function waitForPersistedSnapshot(cwd: string): Promise<void> {
	await vi.waitFor(
		() => expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true),
		{ timeout: 5000 },
	);
}

function makeDeps(tmpDir: string, runtime: RuntimeCoordinator, dbg = vi.fn()) {
	return {
		ctxCwd: tmpDir,
		getFlag: () => false,
		notify: vi.fn(),
		dbg,
		log: () => {},
		runtime,
		metricsClient: { reset: () => {} },
		cacheManager: {
			writeCache: () => {},
			readCache: (key: string) => {
				if (key === "errorDebt") {
					return { data: { pendingCheck: true, baselineTestsPassed: true } };
				}
				return null;
			},
		},
		todoScanner: {
			scanDirectory: () => ({ items: [] }),
			scanFile: (): unknown[] => [],
		},
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			analyze: async () => ({
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "skipped",
			}),
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		deadCodeClients: [],
		govulncheckClient: { ensureAvailable: async () => false },
		gitleaksClient: { ensureAvailable: async () => false },
		trivyClient: { ensureAvailable: async () => false },
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => ({ runner: "vitest", config: null }),
			runTestFile: () => ({ failed: 1, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
	} as any;
}

afterEach(() => {
	delete process.env.PI_LENS_STARTUP_MODE;
	delete process.env.PI_LENS_COLD_START_QUICK;
	delete process.env.PI_LENS_WARMUP_DELAY_MS;
	vi.clearAllMocks();
	// handleSessionStart's cold-start-quick logic gates on a process-global —
	// reset it between tests so each test's "first session" behaves as such.
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	deferredRuntimeSnapshotSave.delayCall = undefined;
	deferredRuntimeSnapshotSave.calls = 0;
	deferredRuntimeSnapshotSave.wordIndexSaveCompleted = false;
	globals.__piLensFirstSessionDone = false;
	globals.__piLensWarmupScheduled = false;
});

describe("word-index lifecycle — full mode (#348)", () => {
	it("builds and persists when no snapshot exists yet (absent)", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-full-absent-");
		const restore = setStartupMode("full");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ type: "module" }),
			);
			createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) { return id; }",
			);
			const runtime = new RuntimeCoordinator();
			runtime.resetForSession();
			const dbg = vi.fn();

			await handleSessionStart(makeDeps(env.tmpDir, runtime, dbg));

			await vi.waitFor(() => expect(runtime.wordIndex).not.toBeNull(), {
				timeout: 5000,
			});
			expect(runtime.wordIndex!.docCount).toBeGreaterThan(0);
			expect(
				dbg.mock.calls.some(([msg]) =>
					String(msg).includes("word-index: rebuilt"),
				),
			).toBe(true);

			const snapshot = loadProjectSnapshot(env.tmpDir);
			expect(snapshot?.wordIndex).toBeDefined();
		} finally {
			env.cleanup();
			restore();
		}
	}, 15_000);

	it("rebuilds when the persisted snapshot's seq is stale", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-full-stale-");
		const restore = setStartupMode("full");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ type: "module" }),
			);
			createTempFile(env.tmpDir, "src/a.ts", "export function helperA() {}");

			// Seed a snapshot at a seq that will NOT match the live seq (0, since
			// no .pi-lens sequence file exists yet) — use a bogus non-zero seq so
			// isProjectSnapshotFresh returns false.
			const staleIndex = buildWordIndex([
				{ path: "stale/ghost.ts", content: "function ghostOnly() {}" },
			]);
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 999, // guaranteed stale vs the live (0) sequence
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(staleIndex),
			});

			const runtime = new RuntimeCoordinator();
			runtime.resetForSession();
			const dbg = vi.fn();

			await handleSessionStart(makeDeps(env.tmpDir, runtime, dbg));

			await vi.waitFor(
				() =>
					expect(
						dbg.mock.calls.some(([msg]) =>
							String(msg).includes("word-index: rebuilt"),
						),
					).toBe(true),
				{ timeout: 5000 },
			);
			// The rebuilt index reflects the real project files, not the stale
			// ghost-only snapshot seeded above.
			expect(runtime.wordIndex?.docLengths.has("stale/ghost.ts")).toBe(false);
		} finally {
			env.cleanup();
			restore();
		}
	}, 15_000);

	it("reuses a fresh persisted snapshot without rebuilding", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-full-fresh-");
		const restore = setStartupMode("full");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ type: "module" }),
			);
			createTempFile(env.tmpDir, "src/a.ts", "export function helperA() {}");

			// First real run builds + persists at the live seq (0, no sequence file).
			const runtime1 = new RuntimeCoordinator();
			runtime1.resetForSession();
			await handleSessionStart(makeDeps(env.tmpDir, runtime1, vi.fn()));
			await vi.waitFor(() => expect(runtime1.wordIndex).not.toBeNull(), {
				timeout: 5000,
			});
			await waitForPersistedSnapshot(env.tmpDir);

			// Second run against the same cwd/seq should reuse, not rebuild.
			const runtime2 = new RuntimeCoordinator();
			runtime2.resetForSession();
			const dbg2 = vi.fn();
			const globals = globalThis as unknown as {
				__piLensFirstSessionDone?: boolean;
			};
			globals.__piLensFirstSessionDone = true; // avoid forcing quick mode again
			await handleSessionStart(makeDeps(env.tmpDir, runtime2, dbg2));

			await vi.waitFor(
				() =>
					expect(
						dbg2.mock.calls.some(([msg]) =>
							String(msg).includes("session_start task word-index: end"),
						),
					).toBe(true),
				{ timeout: 5000 },
			);
			expect(
				dbg2.mock.calls.some(([msg]) =>
					String(msg).includes("word-index: incremental"),
				),
			).toBe(true);
			expect(
				dbg2.mock.calls.some(([msg]) =>
					String(msg).includes("word-index: rebuilt"),
				),
			).toBe(false);
		} finally {
			env.cleanup();
			restore();
		}
	}, 15_000);
	it("full-rebuilds legacy serialization and falls back after refresh refusal", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-fallback-");
		const restore = setStartupMode("full");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ type: "module" }),
			);
			createTempFile(
				env.tmpDir,
				"src/current.ts",
				"export const currentNeedle = 1;",
			);
			const legacy = serializeWordIndex(
				buildWordIndex([
					{ path: "ghost-a.ts", content: "const ghostA = 1;" },
					{ path: "ghost-b.ts", content: "const ghostB = 1;" },
				]),
			) as unknown as Record<string, unknown>;
			legacy.version = 1;
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: legacy as never,
			});

			const legacyRuntime = new RuntimeCoordinator();
			legacyRuntime.resetForSession();
			const legacyDbg = vi.fn();
			deferredRuntimeSnapshotSave.delayCall = 2;
			await handleSessionStart(makeDeps(env.tmpDir, legacyRuntime, legacyDbg));
			await vi.waitFor(
				() =>
					expect(
						legacyDbg.mock.calls.some(([m]) =>
							String(m).includes("word-index: rebuilt"),
						),
					).toBe(true),
				{ timeout: 5000 },
			);
			await vi.waitFor(
				() => {
					expect(
						legacyDbg.mock.calls.filter(([m]) =>
							String(m).includes("project_snapshot: saved"),
						).length,
					).toBeGreaterThanOrEqual(2);
					expect(deferredRuntimeSnapshotSave.wordIndexSaveCompleted).toBe(true);
				},
				{ timeout: 5000 },
			);
			await waitForProjectSnapshotPersistsForTests();
			expect(legacyRuntime.wordIndex?.docLengths.has("ghost-a.ts")).toBe(false);

			// Seed a current-format index whose file set is mostly gone. The
			// incremental path refuses >30% churn and the full fallback succeeds.
			const currentFormat = serializeWordIndex(
				buildWordIndex([
					{ path: "ghost-a.ts", content: "const ghostA = 1;" },
					{ path: "ghost-b.ts", content: "const ghostB = 1;" },
				]),
			);
			const snapshot = loadProjectSnapshot(env.tmpDir)!;
			snapshot.wordIndex = currentFormat;
			saveProjectSnapshot(env.tmpDir, snapshot);
			const fallbackRuntime = new RuntimeCoordinator();
			fallbackRuntime.resetForSession();
			const fallbackDbg = vi.fn();
			await handleSessionStart(
				makeDeps(env.tmpDir, fallbackRuntime, fallbackDbg),
			);
			await vi.waitFor(
				() =>
					expect(
						fallbackDbg.mock.calls.some(([m]) =>
							String(m).includes(
								"incremental preflight selected full rebuild (file-set-churn)",
							),
						),
					).toBe(true),
				{ timeout: 5000 },
			);
			await vi.waitFor(
				() =>
					expect(
						fallbackDbg.mock.calls.some(([m]) =>
							String(m).includes("word-index: rebuilt"),
						),
					).toBe(true),
				{ timeout: 5000 },
			);
		} finally {
			env.cleanup();
			restore();
		}
	}, 15_000);
});

describe("word-index lifecycle — quick-mode cold-start warmup (#348 decision 2)", () => {
	it("the cold-start warmup pass builds and persists the index for a first (quick) session", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-warmup-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ type: "module" }),
			);
			createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) { return id; }",
			);
			process.env.PI_LENS_WARMUP_DELAY_MS = "10";
			// Force the very first invocation to quick mode (no explicit
			// PI_LENS_STARTUP_MODE override) — mirrors a real cold start.
			delete process.env.PI_LENS_STARTUP_MODE;

			const runtime = new RuntimeCoordinator();
			runtime.resetForSession();

			await handleSessionStart(makeDeps(env.tmpDir, runtime, vi.fn()));

			// handleSessionStart returns immediately in quick mode; the warmup
			// (including the folded-in word-index refresh) fires ~10ms later.
			await vi.waitFor(
				() => {
					const snapshot = loadProjectSnapshot(env.tmpDir);
					expect(snapshot?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
		} finally {
			env.cleanup();
		}
	}, 15_000);
});
