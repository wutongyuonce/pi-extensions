/**
 * Event-loop occupancy guard for the LSP workspace-diagnostics file walk.
 *
 * `runWorkspaceDiagnostics` (the `lsp_diagnostics` project-wide tool) enumerates
 * every LSP-supported source file under the project root. That walk used to be a
 * synchronous recursive `readdirSync` recursion, which holds the loop for the
 * whole O(N) enumeration (~44ms at ~1.4k files, scaling linearly on monorepos)
 * and freezes pi's TUI. It is now an async, yielding `fs.promises.readdir`
 * walk. This trip-wire fails if anyone regresses it back to a non-yielding sync
 * walk: at ~1,200 files a synchronous enumeration is hundreds of ms and blows
 * the budget, while the async walk keeps its longest sync stretch in the
 * single-digit-ms range.
 *
 * We measure occupancy (longest synchronous stretch), NOT wall-clock duration —
 * duration cannot tell a TUI-freezing sync burst from harmless async I/O time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __collectWorkspaceDiagnosticFilesForTest } from "../../../clients/lsp/index.js";
import {
	generateSourceTree,
	measureMaxSyncBlockMs,
} from "../../support/perf-harness.js";
import { removeTempDirSync } from "../test-utils.js";

// Same budget the source-walk occupancy guards use: the async walk yields in a
// few ms; the regression we guard against (a sync walk) is hundreds of ms at
// this scale, so 300ms catches it with wide margin while absorbing ambient
// parallel-suite load. retry soaks rare spikes.
const MAX_SYNC_BLOCK_MS = 300;
const TREE_SIZE = 1200;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-lsp-wsdiag-occupancy-"),
	);
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

describe(`LSP workspace-diagnostics walk occupancy (~${TREE_SIZE} files)`, () => {
	it(
		"collectWorkspaceDiagnosticFiles stays under the sync-block budget",
		{ retry: 2, timeout: 30_000 },
		async () => {
			let count = 0;
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				count = (await __collectWorkspaceDiagnosticFilesForTest(tmpDir)).length;
			});
			// The fixture writes .ts/.tsx/.py/.js files — all LSP-supported, so the
			// walk must find a non-trivial set (proves it actually walked).
			expect(count).toBeGreaterThan(0);
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);
});
