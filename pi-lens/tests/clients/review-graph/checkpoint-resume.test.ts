import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	_readReviewGraphCheckpointForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getCachedReviewGraph,
	getCheckpointOffloadCountForTests,
	resetReviewGraphPersistWorkerForTests,
	reviewGraphCachePath,
	waitForReviewGraphPersistsForTests,
} from "../../../clients/review-graph/builder.js";
import { _resetGitIdentityCacheForTests } from "../../../clients/review-graph/git-identity.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import * as reviewGraphLogger from "../../../clients/review-graph-logger.js";
import { removeTempDirSync } from "../test-utils.js";

// #936 limit 2: a full build must be resumable across sessions from a mid-build
// checkpoint, producing a graph identical to a cold full build — with stale
// (content-changed) entries re-walked and the mid-build checkpoint never served
// or persisted as a complete graph.

const roots: string[] = [];

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	clearGraphCache();
	resetReviewGraphPersistWorkerForTests();
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS;
	for (const root of roots.splice(0)) removeTempDirSync(root);
	_resetGitIdentityCacheForTests();
	vi.restoreAllMocks();
});

beforeEach(() => {
	// Keep debounced persists from flushing mid-test (the arms use distinct
	// roots, but this also keeps the checkpoint-delete assertions clean).
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
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

// Compare node SET and edge SET (order-independent): a resumed build reconstructs
// the same union of per-file contributions as a cold build, but the edge ARRAY
// order can differ, which is not semantically meaningful (consumers use indexes).
function graphShape(graph: ReviewGraph, root: string): unknown {
	const nodes = sortedMap(graph.nodes);
	const edges = [...graph.edges].sort((a, b) =>
		JSON.stringify(a).localeCompare(JSON.stringify(b)),
	);
	return canonicalize({ nodes, edges }, root);
}

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [relative, content] of Object.entries(files)) {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

function makeRoot(prefix: string, files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	writeFiles(root, files);
	return root;
}

const SOURCES: Record<string, string> = {
	"src/a.ts": "export const alpha = 1;\n",
	"src/b.ts": "import { alpha } from './a';\nexport const beta = alpha;\n",
	"src/c.ts":
		"import { beta } from './b';\nexport function gamma() { return beta; }\n",
	"src/d.ts": "export function delta() { return 4; }\n",
	"src/e.ts": "import { gamma } from './c';\nexport const eps = gamma();\n",
	"src/f.ts": "import { delta } from './d';\nexport const zeta = delta();\n",
};

async function coldBuild(files: Record<string, string>): Promise<{
	root: string;
	graph: ReviewGraph;
}> {
	const root = makeRoot("pi-lens-ckpt-cold-", files);
	clearReviewGraphWorkspaceCache(root);
	clearGraphCache();
	const graph = await buildOrUpdateGraph(root, [], new FactStore());
	return { root, graph };
}

describe("review-graph resumable checkpoint (#936 limit 2)", () => {
	it("resumes a killed build and produces a graph identical to a cold build", async () => {
		const resumeRoot = makeRoot("pi-lens-ckpt-resume-", SOURCES);

		// Session A: killed after 2 files, having written a checkpoint.
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = "2";
		await expect(
			buildOrUpdateGraph(resumeRoot, [], new FactStore()),
		).rejects.toThrow(/checkpoint_test_abort/);

		const checkpoint = _readReviewGraphCheckpointForTests(resumeRoot);
		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.processedFiles.length).toBe(2);
		// No authoritative snapshot was written by the aborted session.
		expect(fs.existsSync(reviewGraphCachePath(resumeRoot))).toBe(false);

		// New session: cold caches, no stop — must resume and finish.
		delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
		clearReviewGraphWorkspaceCache(resumeRoot);
		clearGraphCache();
		const resumed = await buildOrUpdateGraph(resumeRoot, [], new FactStore());

		const cold = await coldBuild(SOURCES);
		expect(graphShape(resumed, resumeRoot)).toEqual(
			graphShape(cold.graph, cold.root),
		);
		// The completed graph is NOT partial/in-progress.
		expect(resumed.persistCoverage?.partial).not.toBe(true);
		expect(resumed.persistCoverage?.inProgress).not.toBe(true);

		// Checkpoint retired once the authoritative build completed.
		await waitFor(
			() => _readReviewGraphCheckpointForTests(resumeRoot) === null,
		);
		expect(_readReviewGraphCheckpointForTests(resumeRoot)).toBeNull();
	});

	it("re-walks a checkpoint entry whose file changed between sessions", async () => {
		const resumeRoot = makeRoot("pi-lens-ckpt-stale-", SOURCES);

		// Session A: killed after 3 files.
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = "3";
		await expect(
			buildOrUpdateGraph(resumeRoot, [], new FactStore()),
		).rejects.toThrow(/checkpoint_test_abort/);
		const checkpoint = _readReviewGraphCheckpointForTests(resumeRoot);
		expect(checkpoint?.processedFiles.length).toBe(3);

		// Mutate one of the ALREADY-PROCESSED files so its checkpoint entry is
		// now stale — the resume must detect this and re-walk it, not reuse the
		// snapshot's outdated contribution.
		const processedRel = checkpoint!.processedFiles
			.map((abs) => path.relative(resumeRoot, abs).replaceAll("\\", "/"))
			.find((rel) => rel in SOURCES);
		expect(processedRel).toBeDefined();
		const finalSources: Record<string, string> = { ...SOURCES };
		finalSources[processedRel!] =
			`${SOURCES[processedRel!]}export function extra_${processedRel!.replace(/\W/g, "_")}() { return 99; }\n`;
		writeFiles(resumeRoot, { [processedRel!]: finalSources[processedRel!] });

		delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
		clearReviewGraphWorkspaceCache(resumeRoot);
		clearGraphCache();
		const resumed = await buildOrUpdateGraph(resumeRoot, [], new FactStore());

		// Equivalent to a cold build over the POST-EDIT source set.
		const cold = await coldBuild(finalSources);
		expect(graphShape(resumed, resumeRoot)).toEqual(
			graphShape(cold.graph, cold.root),
		);
	});

	it("offloads mid-build checkpoints to the persist worker without corrupting the result, and retires them on completion", async () => {
		const root = makeRoot("pi-lens-ckpt-offload-", SOURCES);
		// Fire an in-loop checkpoint every 2 files with no interval floor, so a
		// 6-file cold build posts offloaded checkpoints mid-extraction (worker
		// enabled — no TEST_STOP_AFTER, which would force the synchronous seam).
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = "2";
		process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
		clearReviewGraphWorkspaceCache(root);
		clearGraphCache();

		const graph = await buildOrUpdateGraph(root, [], new FactStore());
		// Let any in-flight offloaded checkpoint promotion settle.
		await waitForReviewGraphPersistsForTests();

		// The offload path actually fired (not the sync fallback, and not zero
		// checkpoints) — otherwise the assertions below hold trivially for any
		// completed build. Two strides fire for 6 files at EVERY=2 (after files 2
		// and 4; the last chunk is skipped since remainingAfter < EVERY).
		expect(getCheckpointOffloadCountForTests()).toBeGreaterThanOrEqual(1);

		// The offloaded checkpoints never corrupted the built graph: it matches a
		// cold build exactly.
		const cold = await coldBuild(SOURCES);
		expect(graphShape(graph, root)).toEqual(graphShape(cold.graph, cold.root));
		expect(graph.persistCoverage?.inProgress).not.toBe(true);
		expect(graph.persistCoverage?.partial).not.toBe(true);

		// A completed build retires its checkpoint AND a late offloaded promotion
		// cannot resurrect it: deleteReviewGraphCheckpoint bumps the checkpoint
		// generation, so any stage still in flight at completion is gated out.
		await waitFor(() => _readReviewGraphCheckpointForTests(root) === null);
		expect(_readReviewGraphCheckpointForTests(root)).toBeNull();
	});

	it("resumes across a HEAD-only move instead of discarding the checkpoint (#1961)", async () => {
		const resumeRoot = makeRoot("pi-lens-ckpt-headmove-", SOURCES);
		// Minimal hand-built `.git` — no git binary needed. Same fixture shape as
		// tests/clients/review-graph-git-stamp.test.ts.
		const gitDir = path.join(resumeRoot, ".git");
		fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
		fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		const headRef = path.join(gitDir, "refs", "heads", "main");
		fs.writeFileSync(headRef, `${"a".repeat(40)}\n`);
		_resetGitIdentityCacheForTests();

		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = "2";
		await expect(
			buildOrUpdateGraph(resumeRoot, [], new FactStore()),
		).rejects.toThrow(/checkpoint_test_abort/);
		expect(_readReviewGraphCheckpointForTests(resumeRoot)).not.toBeNull();

		// A plain `git commit`: HEAD moves, no file content changes. The resume
		// path hashes every processed file anyway, so revision equality proves
		// nothing the hashes do not — discarding here threw away a whole
		// resumable partial build after each commit.
		fs.writeFileSync(headRef, `${"b".repeat(40)}\n`);
		_resetGitIdentityCacheForTests();

		delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
		clearReviewGraphWorkspaceCache(resumeRoot);
		clearGraphCache();
		const spy = vi.spyOn(reviewGraphLogger, "logReviewGraph");
		const resumed = await buildOrUpdateGraph(resumeRoot, [], new FactStore());

		const phases = spy.mock.calls.map(([entry]) => entry.phase);
		expect(phases).toContain("checkpoint_resumed");
		expect(phases).not.toContain("checkpoint_discarded");
		const cold = await coldBuild(SOURCES);
		expect(graphShape(resumed, resumeRoot)).toEqual(
			graphShape(cold.graph, cold.root),
		);
	});

	it("never serves a mid-build checkpoint as a complete graph", async () => {
		const resumeRoot = makeRoot("pi-lens-ckpt-honesty-", SOURCES);

		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = "2";
		await expect(
			buildOrUpdateGraph(resumeRoot, [], new FactStore()),
		).rejects.toThrow(/checkpoint_test_abort/);

		// A checkpoint exists and is explicitly marked in-progress/partial.
		const checkpoint = _readReviewGraphCheckpointForTests(resumeRoot);
		expect(checkpoint?.inProgress).toBe(true);
		expect(checkpoint?.persistCoverage?.partial).toBe(true);
		expect(checkpoint?.persistCoverage?.inProgress).toBe(true);

		// The read-only accessor must NOT surface the checkpoint: no authoritative
		// snapshot was written, so it degrades to "cold" (undefined) rather than
		// serving a partial mid-build graph.
		clearReviewGraphWorkspaceCache(resumeRoot);
		clearGraphCache();
		expect(getCachedReviewGraph(resumeRoot)).toBeUndefined();
		expect(fs.existsSync(reviewGraphCachePath(resumeRoot))).toBe(false);
	});
});

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
