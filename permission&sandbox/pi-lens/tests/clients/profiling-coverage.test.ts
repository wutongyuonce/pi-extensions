/**
 * Profiling coverage: what percent of the walk/profile hot path a
 * representative source-tree workload actually executes.
 *
 * Occupancy tests (`source-walk-occupancy.test.ts`) guard event-loop stalls.
 * This is the complementary reach metric — pyinstrument-style "did the
 * profiler even touch the production modules" — using V8 precise coverage
 * on the in-place compiled clients.
 *
 * #1521: the original guard checked an AGGREGATE ratio across all 8 hot-path
 * files. A module-scoped regression — e.g. `source-filter.ts` silently
 * bypassing its delegation to `source-walker.ts`'s `walkTreeRecursiveSync`/
 * `walkTreeStackAsync` and reimplementing the walk inline — barely moves the
 * 8-file aggregate (source-walker.js is one of eight files, and other
 * callers of the shared walker still exercise most of it), so the ratio
 * floor never tripped. This guard uses PER-MODULE absolute function-count
 * floors (deterministic reach on the fixed TREE_SIZE fixture — no timing, so
 * no ambient-noise headroom needed), so a bypass fails this test directly
 * instead of hiding inside an aggregate that "cannot fail."
 *
 * The shared-walker delegation entry points (`walkTreeRecursiveSync`,
 * `walkTreeStackAsync`) are proven separately, per call site, via
 * `vi.spyOn` in `source-filter-walker-delegation.test.ts` — its own file,
 * not a second `describe` here, because sharing a process with THIS file's
 * coverage capture is unsafe: see that file's header for why (round 3
 * review; a two-describe-block version in this same file was order-coupled
 * and would misfire under `.only`/`-t`/`--sequence.shuffle`).
 *
 * `clients/path-utils.js` is itself platform-branched (`normalizeFilePath`,
 * `normalizeEphemeralMapKey` early-return on non-win32; downstream,
 * `safe-spawn.ts`'s win32-only git-binary check reaches
 * `isFullyQualifiedWin32`). A function-count floor measured on Windows does
 * not hold on Linux CI for this file — the exact defect shape 2 this guard
 * otherwise exists to catch. `path-utils.js` is EXEMPT from
 * `MIN_FUNCTIONS_HIT` (see `FLOOR_EXEMPT`) and covered instead by
 * `MUST_EXECUTE_FUNCTIONS` entries confirmed to sit behind OS-agnostic call
 * sites (see the comment above that constant).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import { detectProjectLanguageProfileAsync } from "../../clients/language-profile.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "../../clients/source-filter.js";
import { countSourceFilesWithinLimitAsync } from "../../clients/startup-scan.js";
import { generateSourceTree } from "../support/perf-harness.js";
import {
	fileFromScriptUrl,
	summarizePreciseCoverage,
	withPreciseCoverage,
} from "../support/v8-coverage.js";
import { removeTempDirSync } from "./test-utils.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const TREE_SIZE = 400;

/** Compiled in-place clients the walk/profile workload must reach. */
const HOT_PATH = [
	"clients/file-kinds.js",
	"clients/file-utils.js",
	"clients/generated-artifacts.js",
	"clients/language-profile.js",
	"clients/path-utils.js",
	"clients/source-filter.js",
	"clients/source-walker.js",
	"clients/startup-scan.js",
] as const;

const MIN_FILES_TOUCHED = HOT_PATH.length;

/**
 * Hot-path files EXEMPT from `MIN_FUNCTIONS_HIT` — single source of truth
 * for "this file is deliberately unfloored," checked below by
 * `assertFloorCoverageIsExhaustive` so a ninth `HOT_PATH` entry can't slip
 * in unguarded by both the floor table and this set (#1521 review round 3,
 * finding 4: a `Partial<Record<...>>` floor table alone permits silent
 * omission with no error).
 *
 * `clients/path-utils.js`: see the file header — platform-branched, so a
 * Windows-measured absolute floor does not hold on Linux CI.
 */
const FLOOR_EXEMPT = new Set<(typeof HOT_PATH)[number]>([
	"clients/path-utils.js",
]);

/**
 * Absolute per-module function-count floors (#1521), measured against a
 * local (Windows) run of this fixture (functionsHit / functionCount):
 *   file-kinds.js 2/2, file-utils.js 31/32, generated-artifacts.js 17/17,
 *   language-profile.js 9/9, source-filter.js 30/34, source-walker.js 11/11,
 *   startup-scan.js 6/6.
 * Each floor keeps a small margin (1-3 functions) for the one path known to
 * vary with filesystem/cache state (the generated-header content probe in
 * `source-filter.ts`), NOT for ambient timing noise — this metric is
 * deterministic reach on a fixed synthetic tree, so the margin stays tight
 * enough that dropping even one meaningfully-sized module's function trips
 * its own floor instead of hiding in an aggregate.
 */
const MIN_FUNCTIONS_HIT: Record<
	Exclude<(typeof HOT_PATH)[number], "clients/path-utils.js">,
	number
> = {
	"clients/file-kinds.js": 2,
	"clients/file-utils.js": 29,
	"clients/generated-artifacts.js": 16,
	"clients/language-profile.js": 8,
	"clients/source-filter.js": 27,
	"clients/source-walker.js": 10,
	"clients/startup-scan.js": 5,
};

/**
 * Every `HOT_PATH` entry must be either floored (`MIN_FUNCTIONS_HIT`) or
 * explicitly exempt (`FLOOR_EXEMPT`) — never silently neither. Runs once at
 * module load (not inside an `it`) so a config mistake fails loudly on
 * import rather than passing silently because the file it forgot to floor
 * never got checked.
 */
function assertFloorCoverageIsExhaustive(): void {
	const floored = new Set(Object.keys(MIN_FUNCTIONS_HIT));
	const uncovered = HOT_PATH.filter(
		(file) => !floored.has(file) && !FLOOR_EXEMPT.has(file),
	);
	if (uncovered.length > 0) {
		throw new Error(
			`HOT_PATH entries with neither a MIN_FUNCTIONS_HIT floor nor a FLOOR_EXEMPT entry: ${uncovered.join(", ")}`,
		);
	}
	const both = HOT_PATH.filter(
		(file) => floored.has(file) && FLOOR_EXEMPT.has(file),
	);
	if (both.length > 0) {
		throw new Error(
			`HOT_PATH entries both floored and exempt (pick one): ${both.join(", ")}`,
		);
	}
}
assertFloorCoverageIsExhaustive();

/**
 * Named must-execute functions (#1521), covering `clients/path-utils.js`
 * only (its `FLOOR_EXEMPT` replacement signal). Each entry's CALL SITE (not
 * necessarily the callee's own internal branching) was confirmed
 * OS-independent by reading the actual code path this workload exercises —
 * function-level coverage only needs the function invoked, not which
 * internal branch ran, so a callee that branches on `process.platform`
 * internally (e.g. `normalizeFilePath`) is still safe to require as long as
 * every caller reaches it unconditionally:
 *   - `normalizeFilePath`/`normalizeMapKey`: `language-profile.ts`'s
 *     project-profile cache.
 *   - `normalizeEphemeralMapKey`: `source-filter.ts`'s sibling-probe cache.
 *   - `direntsHaveMarkerGlobMatch`/`nameMatchesMarkerGlob`:
 *     `language-profile.ts`'s marker-glob scan.
 *   - `isWindowsPath`: `generated-artifacts.ts`'s `basenameForShape`,
 *     checked for every candidate file regardless of platform.
 * Deliberately EXCLUDES `isFullyQualifiedWin32`, which IS platform-gated
 * (only reachable via `safe-spawn.ts`'s win32-only git-binary validation
 * branch) and so cannot appear in a cross-OS list.
 */
const MUST_EXECUTE_FUNCTIONS: Record<string, readonly string[]> = {
	"clients/path-utils.js": [
		"normalizeFilePath",
		"normalizeMapKey",
		"normalizeEphemeralMapKey",
		"direntsHaveMarkerGlobMatch",
		"nameMatchesMarkerGlob",
		"isWindowsPath",
	],
};

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-profiling-coverage-"),
	);
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

beforeEach(() => {
	_resetGeneratedArtifactCaches();
});

describe(`profiling coverage of walk/profile hot path (~${TREE_SIZE} files)`, () => {
	it(
		"executes a minimum share of functions in the hot-path clients",
		{ timeout: 30_000 },
		async () => {
			const { result, scripts } = await withPreciseCoverage(async () => {
				const syncFiles = collectSourceFiles(tmpDir);
				const asyncFiles = await collectSourceFilesAsync(tmpDir);
				const profile = await detectProjectLanguageProfileAsync(tmpDir);
				const counted = await countSourceFilesWithinLimitAsync(
					tmpDir,
					1_000_000,
				);
				return { syncFiles, asyncFiles, profile, counted };
			});

			expect(result.syncFiles.length).toBeGreaterThan(0);
			expect(result.asyncFiles).toEqual(result.syncFiles);
			expect(result.counted).toBeGreaterThan(0);
			expect(result.profile).toBeTruthy();

			const summary = summarizePreciseCoverage(scripts, {
				root: repoRoot,
				include: HOT_PATH,
			});
			const missing = HOT_PATH.filter(
				(file) =>
					!summary.files.some(
						(entry) => entry.file === file && entry.functionsHit > 0,
					),
			);
			expect(
				missing,
				`hot-path modules with zero executed functions: ${missing.join(", ") || "(none)"}`,
			).toEqual([]);
			expect(summary.filesTouched).toBeGreaterThanOrEqual(MIN_FILES_TOUCHED);

			// Named must-execute functions (#1521, path-utils.js only — see the
			// comment above MUST_EXECUTE_FUNCTIONS) checked BEFORE the per-module
			// floor below, so a failure here always reports on its own merit
			// rather than being masked by the floor check throwing first.
			//
			// Accumulates hit function names across EVERY script entry that
			// resolves to a given file (#1521 review round 3, finding 3), not
			// just the first match `scripts.find()` would return — an ESM/CJS
			// double-load or a URL-casing duplicate would otherwise silently
			// drop coverage from a second entry for the same file, producing a
			// false "never called" red.
			const missingNamed: string[] = [];
			for (const [file, names] of Object.entries(MUST_EXECUTE_FUNCTIONS)) {
				const hit = new Set<string>();
				for (const script of scripts) {
					if (fileFromScriptUrl(script.url, repoRoot) !== file) continue;
					for (const fn of script.functions) {
						if (fn.ranges.some((range) => range.count > 0))
							hit.add(fn.functionName);
					}
				}
				for (const name of names) {
					if (!hit.has(name)) missingNamed.push(`${file}#${name}`);
				}
			}
			expect(
				missingNamed,
				`must-execute functions never called: ${missingNamed.join(", ") || "(none)"}`,
			).toEqual([]);

			// Per-module absolute function-count floors (#1521) — replaces the
			// 8-file aggregate ratio a module-scoped regression could hide inside.
			// Message reports hit/floor AND the module's total functionCount:
			// V8 only lists functions actually compiled during THIS capture
			// window (#1521's own finding), so under a genuine bypass
			// functionCount drops WITH hit — that pairing (both down, same
			// amount) is exactly what a lost call site looks like, NOT a signal
			// to recalibrate the floor. Recalibrate only when the drop traces to
			// an intentional refactor of the module itself (fewer functions
			// defined, not fewer reached).
			const shortfalls = Object.entries(MIN_FUNCTIONS_HIT)
				.filter(([file, floor]) => {
					const entry = summary.files.find((f) => f.file === file);
					return (entry?.functionsHit ?? 0) < floor;
				})
				.map(([file, floor]) => {
					const entry = summary.files.find((f) => f.file === file);
					return `${file}: ${entry?.functionsHit ?? 0}/${floor} functions hit (module has ${entry?.functionCount ?? 0} total)`;
				});
			expect(
				shortfalls,
				`modules under their function-count floor: ${shortfalls.join(", ") || "(none)"}`,
			).toEqual([]);

			// Block-level signal (#1521 review round 2, finding 4): the original
			// aggregate `blockPct` floor is dropped rather than replaced with a
			// per-module absolute block-count floor. Block counts are FINER-grained
			// than function counts (a single function's internal branches can vary
			// by filesystem/cache state — see source-filter.ts's generated-header
			// probe — independent of any platform difference), so an absolute
			// per-module block floor measured on Windows would misfire on Linux CI
			// even for platform-INDEPENDENT files, for reasons unrelated to a real
			// regression. Function-level floors plus the `vi.spyOn` delegation
			// proofs in `source-filter-walker-delegation.test.ts` (a spied call
			// necessarily executed at least one block of its target) are the
			// chosen trade-off: falsifiable and OS-stable, at the cost of
			// aggregate block-percentage signal for regressions that change
			// control flow WITHIN an already-reached function.
		},
	);
});
