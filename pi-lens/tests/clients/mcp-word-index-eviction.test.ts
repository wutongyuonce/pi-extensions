import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_getWarmWordIndexCacheStateForTests,
	_resetWarmWordIndexCacheForTests,
	acquireWarmWordIndex,
} from "../../clients/mcp/analyze.js";
import { symbolSearch } from "../../clients/lens-engine.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	_projectSnapshotParseCacheRetainsWordIndexForTests,
	_resetProjectSnapshotParseCacheForTests,
	getSnapshotBodyReadCountForTests,
	resetSnapshotBodyReadCountForTests,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import {
	buildWordIndex,
	searchWordIndex,
	serializeWordIndex,
} from "../../clients/word-index.js";
import { suspendAt } from "./interleaving-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

function persistIndex(cwd: string, symbol: string): void {
	const index = buildWordIndex([
		{
			path: path.join(cwd, "src", `${symbol}.ts`),
			content: `export const ${symbol} = true;`,
		},
	]);
	saveProjectSnapshot(cwd, {
		version: PROJECT_SNAPSHOT_VERSION,
		projectRoot: cwd,
		generatedAt: new Date().toISOString(),
		seq: 0,
		files: {},
		symbols: {},
		reverseDeps: {},
		cachedExports: [],
		wordIndex: serializeWordIndex(index),
	});
}

describe("MCP warm word-index lifecycle (#1370)", () => {
	let cleanup: (() => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		const env = setupTestEnvironment("word-index-eviction-");
		cleanup = env.cleanup;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		process.env.PI_LENS_WORD_INDEX_IDLE_EVICT_MS = "20";
		process.env.PI_LENS_WORD_INDEX_MAX_WARM_ROOTS = "8";
	});

	afterEach(() => {
		_resetWarmWordIndexCacheForTests();
		_resetProjectSnapshotParseCacheForTests();
		delete process.env.PILENS_DATA_DIR;
		delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
		delete process.env.PI_LENS_WORD_INDEX_IDLE_EVICT_MS;
		delete process.env.PI_LENS_WORD_INDEX_MAX_WARM_ROOTS;
		vi.useRealTimers();
		vi.restoreAllMocks();
		cleanup?.();
	});

	it("idle-evicts and performs a real deserialize rebuild on the next query", async () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "project");
		persistIndex(cwd, "authenticateUser");
		const first = acquireWarmWordIndex(cwd);
		expect(searchWordIndex(first.index!, "authenticate user")).toHaveLength(1);
		const firstIndex = first.index;
		first.release();

		await vi.advanceTimersByTimeAsync(20);
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(0);

		const rebuilt = acquireWarmWordIndex(cwd);
		expect(rebuilt.index).not.toBe(firstIndex);
		expect(searchWordIndex(rebuilt.index!, "authenticate user")).toHaveLength(
			1,
		);
		rebuilt.release();
	});

	it("lease-guards a suspended query from idle eviction", async () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "busy-project");
		persistIndex(cwd, "leasedSymbol");
		const lease = acquireWarmWordIndex(cwd);
		const queryStep = vi.fn(async (index: NonNullable<typeof lease.index>) =>
			searchWordIndex(index, "leased symbol"),
		);
		const suspension = suspendAt(queryStep, async (index) =>
			searchWordIndex(index, "leased symbol"),
		);
		const query = queryStep(lease.index!).finally(() => lease.release());
		await suspension.admitted;

		await vi.advanceTimersByTimeAsync(20);
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(1);
		suspension.release();
		expect(await query).toHaveLength(1);
		suspension.restore();
	});

	it("evicts the least-recently-used idle root at the configured cap", async () => {
		process.env.PI_LENS_WORD_INDEX_MAX_WARM_ROOTS = "2";
		const roots = ["oldest", "middle", "newest"].map((name) =>
			path.join(process.env.PILENS_DATA_DIR!, name),
		);
		for (const [i, root] of roots.entries()) {
			persistIndex(root, `symbol${i}`);
			const lease = acquireWarmWordIndex(root);
			lease.release();
			await vi.advanceTimersByTimeAsync(1);
		}
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(2);
		expect(_getWarmWordIndexCacheStateForTests().keys).not.toContain(roots[0]);
		const rebuiltOldest = acquireWarmWordIndex(roots[0]);
		rebuiltOldest.release();
		// Re-adding the evicted oldest root must evict one of the two prior residents.
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(2);
	});

	it("unrefs owned timers and clears them on disposal", () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "dispose-project");
		persistIndex(cwd, "disposeSymbol");
		const lease = acquireWarmWordIndex(cwd);
		lease.release();
		const timer = _getWarmWordIndexCacheStateForTests().timers[0];
		expect(timer).toBeDefined();
		expect(timer?.hasRef?.()).toBe(false);
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		_resetWarmWordIndexCacheForTests();
		expect(clearSpy).toHaveBeenCalledWith(timer);
		expect(_getWarmWordIndexCacheStateForTests()).toMatchObject({
			size: 0,
			keys: [],
			timers: [],
		});
	});

	it("re-reads the full body once per warm-index eviction cycle and serves metadata from the stripped cache", async () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "snapshot-project");
		persistIndex(cwd, "snapshotSymbol");
		// Model a reader process that did not perform the write/promotion itself.
		_resetProjectSnapshotParseCacheForTests();
		resetSnapshotBodyReadCountForTests();

		expect((await symbolSearch("snapshot symbol", cwd)).results).toHaveLength(
			1,
		);
		// acquireWarmWordIndex performs the sole full-body read; symbolSearch's
		// metadata load shares the postings-stripped cached body.
		expect(getSnapshotBodyReadCountForTests()).toBe(1);
		expect(_projectSnapshotParseCacheRetainsWordIndexForTests()).toBe(false);

		expect((await symbolSearch("snapshot symbol", cwd)).results).toHaveLength(
			1,
		);
		expect(getSnapshotBodyReadCountForTests()).toBe(1);

		await vi.advanceTimersByTimeAsync(20);
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(0);
		expect((await symbolSearch("snapshot symbol", cwd)).results).toHaveLength(
			1,
		);
		expect(getSnapshotBodyReadCountForTests()).toBe(2);
		expect(_projectSnapshotParseCacheRetainsWordIndexForTests()).toBe(false);
	});
});
