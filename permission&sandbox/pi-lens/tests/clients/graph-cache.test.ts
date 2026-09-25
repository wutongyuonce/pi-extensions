import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
	getReviewGraphCacheIdentity,
	getReviewGraphWorkspaceCacheSnapshot,
	_getReviewGraphWorkspaceCacheKeysForTests,
	_setReviewGraphWorkspaceEntryForTests,
	_setReviewGraphBuildGateForTests,
} from "../../clients/review-graph/builder.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	createTempFile,
	removeTempDirSync,
	setupTestEnvironment,
} from "./test-utils.js";

// NOTE: this mock is vestigial for the builder path — buildOrUpdateGraph walks
// via project-scan-policy/source-filter, not scan-utils, so these tests run a
// REAL (tiny, per-test tmpdir) walk. Kept only to keep any incidental
// scan-utils import inert.
vi.mock("../../clients/scan-utils.js", () => ({
	getSourceFiles: vi.fn().mockReturnValue([]),
}));

describe("buildOrUpdateGraph — Promise dedup cache", () => {
	const dirs: string[] = [];

	beforeEach(() => {
		clearReviewGraphWorkspaceCache();
	});

	afterEach(() => {
		_setReviewGraphBuildGateForTests(undefined);
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) {
			removeTempDirSync(dir);
		}
	});

	it("does not resurrect a build captured before an all-workspace reset", async () => {
		const cwd = tmpDir();
		const facts = new FactStore();
		let release!: () => void;
		const admitted = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		_setReviewGraphBuildGateForTests(async () => {
			entered();
			await admitted;
		});

		const build = buildOrUpdateGraph(cwd, [], facts);
		await started;
		clearReviewGraphWorkspaceCache();
		release();

		const graph = await build;
		expect(graph).toHaveProperty("nodes");
		expect(getReviewGraphWorkspaceCacheSnapshot().cacheEntries).toBe(0);
	});

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-graph-cache-"));
		dirs.push(dir);
		return dir;
	}

	it("returns the same Promise for identical cwd+changedFiles", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(p1).toBe(p2);
		await p1;
	});

	it("evicts an idle workspace and rebuilds it", async () => {
		// #1656: `buildOrUpdateGraph` does a real `git ls-files` spawn under the
		// hood (clients/git-tracked-ignore.ts), and safeSpawnAsync's post-exit
		// pipe-idle wait now genuinely depends on `setTimeout` to settle (not
		// just Node's native "close" event, which bare `vi.useFakeTimers()`
		// can't touch). `shouldAdvanceTime` lets fake timers tick forward in
		// real time automatically so that real spawn still resolves, while
		// `vi.advanceTimersByTime` below can still jump the clock forward for
		// the idle-eviction check itself.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.stubEnv("PI_LENS_REVIEW_GRAPH_IDLE_EVICT_MS", "1000");
		const cwd = tmpDir();
		const facts = new FactStore();
		const first = await buildOrUpdateGraph(cwd, [], facts);
		expect(getReviewGraphWorkspaceCacheSnapshot().cacheEntries).toBe(1);
		vi.advanceTimersByTime(1001);
		expect(getReviewGraphWorkspaceCacheSnapshot().cacheEntries).toBe(0);
		const second = await buildOrUpdateGraph(cwd, [], facts);
		expect(second).not.toBe(first);
		expect(second.nodes.size).toBe(first.nodes.size);
		vi.useRealTimers();
	});

	it("keeps one live idle-eviction timer per replacement", () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_REVIEW_GRAPH_IDLE_EVICT_MS", "100000");
		const graph = { nodes: new Map(), edges: [] } as never;
		const before = vi.getTimerCount();
		for (let i = 0; i < 20; i++)
			_setReviewGraphWorkspaceEntryForTests("workspace", graph);
		expect(vi.getTimerCount() - before).toBe(1);
		vi.useRealTimers();
	});

	it("keeps the eight most recently used workspaces", async () => {
		const facts = new FactStore();
		const roots: string[] = [];
		for (let i = 0; i < 9; i++) {
			const cwd = tmpDir();
			roots.push(cwd);
			await buildOrUpdateGraph(cwd, [], facts);
		}
		const keys = _getReviewGraphWorkspaceCacheKeysForTests();
		expect(keys).toHaveLength(8);
		expect(keys).not.toContain(normalizeMapKey(roots[0]));
		expect(keys).toContain(normalizeMapKey(roots[8]));
	});

	it("normalises changedFiles order — same promise regardless of sort order", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(
			cwd,
			[path.join(cwd, "a.ts"), path.join(cwd, "b.ts")],
			facts,
		);
		const p2 = buildOrUpdateGraph(
			cwd,
			[path.join(cwd, "b.ts"), path.join(cwd, "a.ts")],
			facts,
		);
		expect(p1).toBe(p2);
		await p1;
	});

	it("returns distinct Promises for different changedFiles", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "b.ts")], facts);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("returns distinct Promises for different cwd values", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph(
			tmpDir(),
			[path.join(tmpDir(), "x.ts")],
			facts,
		);
		const p2 = buildOrUpdateGraph(
			tmpDir(),
			[path.join(tmpDir(), "x.ts")],
			facts,
		);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("clearGraphCache() forces a fresh build for the same key", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		await p1;
		clearGraphCache();
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(p1).not.toBe(p2);
		await p2;
	});

	it("reuses the workspace graph when source signature is unchanged", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		await buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);
		clearGraphCache();
		await buildOrUpdateGraph(cwd, [path.join(cwd, "b.ts")], facts);
		expect(getLastGraphBuildInfo()).toEqual({
			reused: true,
			mode: "cached",
			graphChanged: false,
			seqFastpathFallback: undefined,
		});
	});

	it("reuses the cached graph when mtime drifts but content is unchanged (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const file = path.join(cwd, "drift.ts");
		fs.writeFileSync(
			file,
			"export function driftExample() {\n\treturn 1;\n}\n",
		);

		await buildOrUpdateGraph(cwd, [file], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false); // full build

		// Bump mtime into the future WITHOUT changing content → size/mtime
		// signature differs, but the content hash matches.
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(file, future, future);

		clearGraphCache(); // drop the promise-dedup cache so the call re-executes
		// changedFiles=[] — the caller did NOT declare drift.ts changed. Pre-#202
		// this fell through to a full rebuild; now the content-hash confirm proves
		// nothing changed and the cached graph is reused.
		await buildOrUpdateGraph(cwd, [], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(true);
		expect(info.mode).toBe("cached");
	});

	it("stamps buildGeneration — no-op builds carry it forward, content changes mint a new one (#459)", async () => {
		// #1137: this test forces a full rebuild by clearing the caches, but
		// `clearReviewGraphWorkspaceCache`/`clearGraphCache` only drop the two
		// IN-MEMORY tiers. `buildOrUpdateGraph` also has an on-disk tier
		// (`loadPersistedGraph`, "Tier 2") fed by a DEBOUNCED, unref'd persist
		// timer (1500ms by default) — so whether the disk snapshot exists by the
		// time the third build runs was never deterministic, it just happened to
		// still be pending. The moment anything added event-loop turns ahead of
		// it the persist flushed mid-build and the third build legitimately
		// served `mode: "cached"` off disk. (Deleting the cache dir before the
		// build does NOT fix it — the pending timer simply recreates the file
		// during the build.) Suppressing the persist for this test keeps the
		// disk tier genuinely empty, which is the state the assertions assume.
		vi.stubEnv("PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS", String(10 * 60_000));
		const facts = new FactStore();
		const cwd = tmpDir();
		// #1107: was "gen.ts" — the source walk's generated-artifact NAME
		// heuristic silently drops that name, so this test was unknowingly
		// exercising an empty-walk build. Its assertions only check
		// buildGeneration/cache-mode plumbing (never node/symbol content), so
		// renaming to a non-generated-looking name doesn't change behavior —
		// it just makes the walk real instead of accidentally empty.
		const file = path.join(cwd, "buildstamp.ts");
		fs.writeFileSync(file, "export function genA() {\n\treturn 1;\n}\n");

		const g1 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(g1.buildGeneration).toBeDefined();

		// Unchanged content → cache-hit build returns a fresh clone with the SAME
		// stamp, so derived-data caches (reverse-deps index) can prove reusability.
		clearGraphCache();
		const g2 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(getLastGraphBuildInfo().mode).toBe("cached");
		expect(g2.buildGeneration).toBe(g1.buildGeneration);

		// A graph-mutating build (here: full rebuild after a workspace-cache clear)
		// mints a NEW stamp. (The incremental/content-change paths are covered with
		// real files in review-graph-seq-fastpath.test.ts; since the #1107 fixture
		// rename this harness's walk is REAL — the builder walks via
		// project-scan-policy, not the mocked scan-utils — so we force the rebuild
		// explicitly by clearing the caches rather than editing content.)
		clearReviewGraphWorkspaceCache();
		clearGraphCache();
		const g3 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(getLastGraphBuildInfo().mode).toBe("full");
		expect(g3.buildGeneration).toBeDefined();
		expect(g3.buildGeneration).not.toBe(g1.buildGeneration);
	});

	// #1088: getReviewGraphCacheIdentity's consistency guard used to compare
	// `version` (the constant schema tag, e.g. "v8" — identical for every live
	// graph), so it could never detect that a caller's `graph` reference had
	// gone stale relative to the workspace cache (the concrete race: a session
	// call-graph task computes a projection from an older `graph` instance
	// while a concurrent cascade build replaces `_workspaceGraphCache` with a
	// newer one before the identity lookup runs). Comparing `buildGeneration`
	// — the per-content generation stamp that travels with each graph instance
	// (#459) — actually distinguishes "the graph I have" from "the graph
	// currently cached".
	it("rejects a stale graph instance's identity once the workspace cache has moved on (#1088)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		// #1107: was "gen.ts" — same empty-walk-fixture drift as the
		// buildGeneration test above; this test only asserts on
		// buildGeneration/identity plumbing, never node/symbol content, so the
		// rename to a non-generated-looking name is behavior-preserving.
		const file = path.join(cwd, "identitycheck.ts");
		fs.writeFileSync(file, "export function genA() {\n\treturn 1;\n}\n");

		const g1 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(g1.buildGeneration).toBeDefined();
		// g1 is current: its identity resolves.
		expect(getReviewGraphCacheIdentity(cwd, g1)).toBeDefined();

		// Clearing BOTH caches forces a full rebuild (content is unchanged —
		// the workspace-cache clear alone is what makes it "full"), which
		// replaces the workspace cache with a NEW graph instance carrying a
		// NEW buildGeneration, simulating the concurrent build that raced
		// ahead of a caller still holding `g1`.
		clearReviewGraphWorkspaceCache();
		clearGraphCache();
		const g3 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(g3.buildGeneration).not.toBe(g1.buildGeneration);

		// The caller's stale `g1` reference must NOT resolve an identity now
		// that the cache holds a different graph — that would let a stale
		// projection be persisted under the newer (still-live) signature.
		expect(getReviewGraphCacheIdentity(cwd, g1)).toBeUndefined();
		// The current graph still resolves normally.
		expect(getReviewGraphCacheIdentity(cwd, g3)).toBeDefined();
	});

	// #1088 round 2: the guard must compare the cache ENTRY's generation stamp,
	// not the stored graph OBJECT's — the pure-drift reuse path stores an
	// unstamped `cloneGraph` copy in the workspace cache and stamps only the
	// returned instance, so an object-stamp compare rejects the very graph a
	// reuse build just returned (identity undefined → the session call-graph
	// task bails → call graph silently off after any mtime-only drift).
	// Uses a real project dir (not this file's mocked-walk tmpDir): the drift
	// branch only fires when the size:mtimeMs signature diverges while the
	// content hash confirms nothing changed. NOTE: the fixture must not be
	// named `gen.ts` — the source walk's generated-artifact name heuristic
	// silently drops it and the walk (and thus the signature) comes up empty.
	it("resolves the identity of the graph returned by a pure-drift reuse build (#1088)", async () => {
		const env = setupTestEnvironment("pi-lens-graph-drift-");
		try {
			const facts = new FactStore();
			const file = createTempFile(
				env.tmpDir,
				"src/alpha.ts",
				"export function alphaFn() {\n\treturn 1;\n}\n",
			);

			const g1 = await buildOrUpdateGraph(env.tmpDir, [file], facts);
			expect(g1.buildGeneration).toBeDefined();
			expect(getReviewGraphCacheIdentity(env.tmpDir, g1)).toBeDefined();

			// mtime-only touch: signature diverges, content hash confirms
			// unchanged → the pure-drift reuse path replaces the workspace
			// entry with a fresh (unstamped) clone of the cached graph.
			clearGraphCache();
			const bumped = new Date(Date.now() + 5_000);
			fs.utimesSync(file, bumped, bumped);
			const g2 = await buildOrUpdateGraph(env.tmpDir, [file], facts);
			expect(getLastGraphBuildInfo()).toMatchObject({
				reused: true,
				graphChanged: false,
			});
			expect(g2.buildGeneration).toBe(g1.buildGeneration);
			// The graph the reuse build just returned must resolve an identity.
			expect(getReviewGraphCacheIdentity(env.tmpDir, g2)).toBeDefined();
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});

	it("resolves to a ReviewGraph with version and builtAt fields", async () => {
		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(tmpDir(), [], facts);
		expect(graph).toHaveProperty("version");
		expect(graph).toHaveProperty("builtAt");
	});

	it("incrementally adds a newly-created file instead of a full rebuild (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const a = path.join(cwd, "a.ts");
		fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");
		await buildOrUpdateGraph(cwd, [a], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false); // full build

		// A new sibling file appears — pre-#202 the differing file COUNT bailed to
		// a full whole-repo rebuild; now it's an incremental add.
		const b = path.join(cwd, "b.ts");
		fs.writeFileSync(b, "export function bravoSymbol() {\n\treturn 2;\n}\n");

		clearGraphCache(); // drop promise-dedup; keep the warm workspace cache
		const graph = await buildOrUpdateGraph(cwd, [b], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(true);
		expect(info.mode).toBe("incremental"); // NOT a full rebuild
		expect(
			[...graph.nodes.values()].some((n) =>
				n.symbolName?.includes("bravoSymbol"),
			),
		).toBe(true);
	});

	it("incrementally updates a file that changed on disk outside the edit set (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const a = path.join(cwd, "a.ts");
		const b = path.join(cwd, "b.ts");
		fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");
		fs.writeFileSync(b, "export function bravoOldName() {\n\treturn 2;\n}\n");
		await buildOrUpdateGraph(cwd, [a], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);

		// b changes on disk, but the caller only declares `a` changed. The dropped
		// `.every(in changedSet)` guard used to force a full rebuild here.
		fs.writeFileSync(b, "export function bravoNewName() {\n\treturn 3;\n}\n");
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(b, future, future);

		clearGraphCache();
		const graph = await buildOrUpdateGraph(cwd, [a], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(true);
		expect(info.mode).toBe("incremental");
		const names = [...graph.nodes.values()].map((n) => n.symbolName ?? "");
		expect(names.some((n) => n.includes("bravoNewName"))).toBe(true);
		expect(names.some((n) => n.includes("bravoOldName"))).toBe(false);
	});

	it("falls back to a full rebuild when a file is removed (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const a = path.join(cwd, "a.ts");
		const b = path.join(cwd, "b.ts");
		fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");
		fs.writeFileSync(b, "export function bravoSymbol() {\n\treturn 2;\n}\n");
		await buildOrUpdateGraph(cwd, [a], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);

		// A removal must prune nodes/edges — incremental update doesn't apply, so
		// the helper bails and the caller does a correct full rebuild.
		fs.rmSync(b);

		clearGraphCache();
		const graph = await buildOrUpdateGraph(cwd, [a], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(false);
		expect(info.mode).toBe("full");
		expect(
			[...graph.nodes.values()].some((n) =>
				n.symbolName?.includes("bravoSymbol"),
			),
		).toBe(false);
	});
});
