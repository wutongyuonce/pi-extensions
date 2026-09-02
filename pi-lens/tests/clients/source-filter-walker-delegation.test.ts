/**
 * Per-call-site proof that `source-filter.ts`'s sync and async collectors
 * each delegate directly to `source-walker.ts`'s shared walker engine
 * (`walkTreeRecursiveSync` / `walkTreeStackAsync`), instead of silently
 * reimplementing the walk inline (#1521).
 *
 * A spy is a call-graph fact, not a coverage-instrumentation artifact — this
 * is deliberately its OWN test file (a separate vitest worker/process),
 * not a second `describe` in `profiling-coverage.test.ts`. Round 3 review
 * found the two-describe-block version order-coupled: the spy tests must
 * run AFTER the coverage-capture test in that file, because merely CALLING
 * the hot-path functions (even without coverage instrumentation active)
 * JIT-warms `file-utils.js`/`path-utils.js` enough that a LATER V8
 * precise-coverage capture in the same process silently loses functions
 * (`file-utils.js` measured 15/15 instead of 31/32 during review) —
 * corrupting the unrelated function-count floors. That ordering held only
 * by declaration order and a prose comment: `.only`, a `-t` filter, or
 * `--sequence.shuffle` could silently flip it. Splitting into a separate
 * file removes the shared-process contract entirely — nothing in this file
 * calls `withPreciseCoverage`, so there is nothing left to warm.
 *
 * `startup-scan.ts`'s `countSourceFilesWithinLimitAsync` ALSO calls
 * `walkTreeStackAsync`, so a workload that exercises both callers can't
 * tell which one produced a hit — each test below calls ONLY the ONE
 * collector under test, so the spy assertion is per-call-site evidence for
 * that collector's own delegation specifically.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "../../clients/source-filter.js";
import * as sourceWalker from "../../clients/source-walker.js";
import { generateSourceTree } from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

const TREE_SIZE = 400;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-walker-delegation-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

describe("shared-walker delegation call sites (#1521)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// `source-filter.ts`'s sync collector is source-walker.ts's ONLY caller of
	// `walkTreeRecursiveSync` in this codebase today, but the spy proves it
	// directly rather than relying on that staying true.
	it("collectSourceFiles (sync) calls walkTreeRecursiveSync directly", () => {
		const spy = vi.spyOn(sourceWalker, "walkTreeRecursiveSync");
		const files = collectSourceFiles(tmpDir);
		expect(files.length).toBeGreaterThan(0);
		expect(spy).toHaveBeenCalled();
	});

	it("collectSourceFilesAsync (async) calls walkTreeStackAsync directly", async () => {
		const spy = vi.spyOn(sourceWalker, "walkTreeStackAsync");
		const files = await collectSourceFilesAsync(tmpDir);
		expect(files.length).toBeGreaterThan(0);
		expect(spy).toHaveBeenCalled();
	});
});
