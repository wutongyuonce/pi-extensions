import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	resetReviewGraphPersistWorkerForTests,
} from "../../../clients/review-graph/builder.js";
import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
} from "../../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "../test-utils.js";

// #1941: the Tier-3 full review-graph build parses a project's whole
// non-jsts file set through the shared `TreeSitterClient`'s `TreeCache`
// (`extractTreeSitterSymbols` -> `withParsedTree` -> `treeCache.get`/`.set`,
// clients/tree-sitter-client.ts:1490-1509) but never called
// `ensureTreeCacheCapacity` before doing so — the #1715 fix wired that call
// into the diagnostics scanner (scanner.ts:147) but review-graph's sibling
// full-project scan was left at the interactive 50-entry default
// (`TREE_CACHE_DEFAULT_MAX_SIZE`). A project whose non-jsts file count
// exceeds 50 evicts and re-parses files past the 50th on every Tier-3 build.
//
// Uses python fixtures (kind "python") because the jsts kind never routes
// through `TreeCache` (`addFileToGraph`, builder.ts:3921 — jsts uses its own
// extraction path), so a jsts-only fixture could never observe this class of
// defect.

const roots: string[] = [];

// Varying, non-uniform per-file sizes (#1942 review-round shape) so a
// content-hash/byte-count assertion can't be trivially satisfied by a
// uniform fixture; not load-bearing for THIS test's assertions (which check
// cache capacity and hit/miss counters, not bytes), but keeps the fixture
// itself honest about what "a real project" looks like.
function pySource(i: number): string {
	const bodyLines = 3 + ((i * 17) % 11);
	const lines = Array.from(
		{ length: bodyLines },
		(_, j) => `    value_${j} = ${i * 31 + j}`,
	);
	return `def fn_${i}():\n${lines.join("\n")}\n    return value_0\n`;
}

function writePythonFiles(root: string, count: number): string[] {
	const dir = path.join(root, "src");
	fs.mkdirSync(dir, { recursive: true });
	const files: string[] = [];
	for (let i = 0; i < count; i++) {
		const file = path.join(dir, `mod_${i}.py`);
		fs.writeFileSync(file, pySource(i));
		files.push(file);
	}
	return files;
}

function makeRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

beforeEach(() => {
	// Keep the debounced disk persist from landing mid-test so a second
	// `buildOrUpdateGraph` call still takes the Tier-3 full-build path
	// instead of serving a just-written disk cache.
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
});

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	clearGraphCache();
	resetReviewGraphPersistWorkerForTests();
	_resetSharedTreeSitterClientForTests();
	delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

describe("Tier-3 full build grows the tree cache to its file count (#1941)", () => {
	it("sizes the cache past the 50-entry default so a second Tier-3 build on the same files hits, not re-parses", async () => {
		const root = makeRoot("pi-lens-t3-cap-");
		const fileCount = 60; // over TREE_CACHE_DEFAULT_MAX_SIZE (50)
		writePythonFiles(root, fileCount);

		await buildOrUpdateGraph(root, [], new FactStore());

		const client = getSharedTreeSitterClient();
		expect(client).not.toBeNull();
		const afterFirst = client?.getParseCacheStats();
		// Pinning the fix directly: the cache must have grown to span this
		// build's working set, not sat at the 50-entry default.
		expect(afterFirst?.maxSize).toBeGreaterThanOrEqual(fileCount);
		// Every file is still resident — nothing was evicted mid-build by a
		// cache that grew too late (or not at all).
		expect(afterFirst?.size).toBe(fileCount);

		// Force a second Tier-3 build over the identical, unchanged file set
		// (workspace/build caches cleared; TreeCache itself stays warm, as it
		// would across two scans in the same live process).
		clearReviewGraphWorkspaceCache(root);
		clearGraphCache();
		await buildOrUpdateGraph(root, [], new FactStore());

		const afterSecond = client?.getParseCacheStats();
		// The #1715 pattern: a cache sized for the whole working set records
		// zero capacityMisses across both builds. Deleting the
		// `ensureTreeCacheCapacity` call (or reverting to the 50-entry
		// default) makes files 51-60 evict-and-reparse on every build,
		// which shows up here as capacityMisses > 0.
		expect(afterSecond?.capacityMisses).toBe(0);
	}, 30000);
});

describe("Tier-3 checkpoint resume sizes the cache to the RESUMING pass, not the original target (#1941)", () => {
	it("grows the cache to the checkpoint's remaining file count, not the full project's filesToBuild count", async () => {
		const root = makeRoot("pi-lens-t3-cap-resume-");
		const totalFiles = 90;
		const stopAfter = 20;
		const expectedRemaining = totalFiles - stopAfter;
		writePythonFiles(root, totalFiles);

		// Session A: killed mid-build after `stopAfter` files, having written
		// a checkpoint (same seam as tests/clients/review-graph/checkpoint-resume.test.ts).
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = String(stopAfter);
		await expect(buildOrUpdateGraph(root, [], new FactStore())).rejects.toThrow(
			/checkpoint_test_abort/,
		);
		delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;

		// Session B: a new process would start with a cold tree cache — reset
		// the singleton so the capacity we observe below can only have come
		// from THIS resumed pass, not session A's cold-build call.
		_resetSharedTreeSitterClientForTests();
		clearReviewGraphWorkspaceCache(root);
		clearGraphCache();

		await buildOrUpdateGraph(root, [], new FactStore());

		const client = getSharedTreeSitterClient();
		// If the fix sized capacity to `filesToBuild.length` (90, the
		// original full-project target) instead of the resumed pass's actual
		// per-parse working set (`filesToExtract.length`, the checkpoint's 70
		// remaining files), this would read 90, not 70. Resumed files are
		// reused from the checkpoint graph and never re-parsed in this pass,
		// so sizing to the full target would over-grow the cache for files
		// this pass never touches.
		expect(client?.getParseCacheStats().maxSize).toBe(expectedRemaining);
	}, 30000);
});
