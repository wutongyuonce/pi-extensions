/**
 * Event-loop occupancy guards for the async source/tree walkers, at the scale
 * where the O(N) burst actually bites (#192). These are the CI trip-wires that
 * would have caught the ~1.5s synchronous enumeration freeze (#188/#191): each
 * walker must keep its longest synchronous stretch well under pi's typing
 * window on a ~2,000-file project. A regression to a non-yielding walk shows up
 * as a multi-hundred-ms (or full ~1.5s) block and trips the budget.
 *
 * We measure occupancy (longest sync block), NOT wall-clock duration — duration
 * can't tell a TUI-freezing sync burst from harmless async time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import { detectProjectLanguageProfileAsync } from "../../clients/language-profile.js";
import { collectSourceFilesAsync } from "../../clients/source-filter.js";
import { countSourceFilesWithinLimitAsync } from "../../clients/startup-scan.js";
import {
	generateSourceTree,
	measureMaxSyncBlockMs,
} from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

// Generous trip-wire: the walkers yield in ~tens of ms; the regression we guard
// against (a non-yielding walk) is ~0.8-1.5s at this scale, so 300ms catches it with a wide margin while
// absorbing ambient parallel-suite load; retry on each test soaks rare spikes.
const MAX_SYNC_BLOCK_MS = 300;
// ~1,200 files is enough to make a non-yielding regression blow the budget
// (a synchronous walk at this size is ~0.8s ≫ 300ms) while keeping the fixture
// light enough not to starve other parallel tests. The point is the trip-wire,
// not an exact 2k repro.
const TREE_SIZE = 1200;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-walk-occupancy-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

beforeEach(() => {
	// Force cold header reads (the dominant per-file cost) for a worst-case walk.
	_resetGeneratedArtifactCaches();
});

describe(`source-walk event-loop occupancy (~${TREE_SIZE} files)`, () => {
	it(
		"collectSourceFilesAsync stays under the sync-block budget",
		{ retry: 2, timeout: 30_000 },
		async () => {
			let count = 0;
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				count = (await collectSourceFilesAsync(tmpDir)).length;
			});
			expect(count).toBeGreaterThan(0);
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);

	it(
		"detectProjectLanguageProfileAsync stays under the sync-block budget",
		{ retry: 2, timeout: 30_000 },
		async () => {
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				await detectProjectLanguageProfileAsync(tmpDir);
			});
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);

	it(
		"countSourceFilesWithinLimitAsync stays under the sync-block budget",
		{ retry: 2, timeout: 30_000 },
		async () => {
			let n = 0;
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				// Huge limit so it walks the whole tree (no early-exit short-circuit).
				n = await countSourceFilesWithinLimitAsync(tmpDir, 1_000_000);
			});
			expect(n).toBeGreaterThan(0);
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);
});
