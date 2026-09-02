/**
 * #1976: the project ignore matcher must compile each gitignore glob once
 * per (pattern, flags) per matcher instance. The pre-fix code called the
 * plain `minimatch()` helper per (file × ancestor dir × pattern ×
 * candidate) — a fresh `Minimatch` construction (full glob parse plus
 * regex compile) on every call. In a walk over unique paths the per-path
 * verdict memo never hits, so #1974's profiling measured ~60% of a
 * 45,378-file warmup walk's CPU inside minimatch compilation alone.
 *
 * The correctness trap the issue states up front: gitignore patterns are
 * directory-relative. A nested .gitignore scopes its patterns to its
 * subtree, so a cache that stored per-PATTERN VERDICTS would leak a
 * subtree's answers to sibling trees. These tests pin that the memo holds
 * only compiled matchers (context-free — the subject path is resolved
 * relative to each pattern's owning directory by the caller, never
 * cached), so identical pattern text in two subtrees shares one compiled
 * glob while keeping independent verdicts.
 *
 * Counts are asserted on Minimatch.prototype.make invocations (one per
 * real compilation), never wall time (#1920).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// Direct package import: resolves to the SAME module instance
// clients/deps/minimatch.js re-exports, so a prototype spy counts every
// construction the matcher performs. Deliberately not the deps accessor —
// the pre-fix tree (#1976 red run) does not re-export the class yet, and a
// red proof must fail on the bug, not on a missing import.
import { Minimatch } from "minimatch";
import {
	createProjectIgnoreMatcher,
	getProjectIgnoreMatcher,
	invalidateProjectIgnoreMatcherForPath,
} from "../../clients/file-utils.js";
import { collectSourceFilesForWarmup } from "../../clients/language-profile.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

/** Counts real minimatch compilations: `make()` runs once per `new
 * Minimatch(...)`, which is exactly the work #1976 memoizes. Spying the
 * prototype of the shared package instance counts every construction in
 * the process, so each test only runs its own walks inside the window. */
function compileCounter() {
	const spy = vi.spyOn(Minimatch.prototype, "make");
	return {
		get count(): number {
			return spy.mock.calls.length;
		},
	};
}

// A failed assertion must not leak an installed spy into the next test
// (observed in the pre-fix red run: a failing test's count carried over
// and redened an unrelated sibling for the wrong reason).
afterEach(() => {
	vi.restoreAllMocks();
});

describe("#1976 compiled-glob memo", () => {
	it("refreshes a previously ignored path after a nested .gitignore edit", () => {
		const env = setupTestEnvironment("pi-lens-2071-ignore-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			const nested = path.join(env.tmpDir, "packages", "app");
			fs.mkdirSync(nested, { recursive: true });
			const ignoredPath = path.join(nested, "generated.ts");
			fs.writeFileSync(path.join(nested, ".gitignore"), "generated.ts\n");
			const first = getProjectIgnoreMatcher(env.tmpDir);
			expect(first.isIgnored(ignoredPath)).toBe(true);

			fs.writeFileSync(path.join(nested, ".gitignore"), "!generated.ts\n");
			invalidateProjectIgnoreMatcherForPath(path.join(nested, ".gitignore"));
			const second = getProjectIgnoreMatcher(env.tmpDir);
			expect(second.isIgnored(ignoredPath)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("refreshes a previously allowed path after a nested .gitignore edit", () => {
		const env = setupTestEnvironment("pi-lens-2071-allow-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			const nested = path.join(env.tmpDir, "packages", "app");
			fs.mkdirSync(nested, { recursive: true });
			const ignoredPath = path.join(nested, "generated.ts");
			fs.writeFileSync(path.join(nested, ".gitignore"), "!generated.ts\n");
			const first = getProjectIgnoreMatcher(env.tmpDir);
			expect(first.isIgnored(ignoredPath)).toBe(false);

			fs.writeFileSync(path.join(nested, ".gitignore"), "generated.ts\n");
			invalidateProjectIgnoreMatcherForPath(path.join(nested, ".gitignore"));
			const second = getProjectIgnoreMatcher(env.tmpDir);
			expect(second.isIgnored(ignoredPath)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("handles nested .gitignore creation and deletion without flushing siblings", () => {
		const env = setupTestEnvironment("pi-lens-2071-lifecycle-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			const changedDir = path.join(env.tmpDir, "packages", "changed");
			const siblingDir = path.join(env.tmpDir, "packages", "sibling");
			fs.mkdirSync(changedDir, { recursive: true });
			fs.mkdirSync(siblingDir, { recursive: true });
			const changedPath = path.join(changedDir, "generated.ts");
			const siblingPath = path.join(siblingDir, "generated.ts");
			const ignorePath = path.join(changedDir, ".gitignore");
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(changedPath)).toBe(false);
			expect(matcher.isIgnored(siblingPath)).toBe(false);

			fs.writeFileSync(ignorePath, "generated.ts\n");
			invalidateProjectIgnoreMatcherForPath(ignorePath);
			expect(getProjectIgnoreMatcher(env.tmpDir)).toBe(matcher);
			expect(matcher.isIgnored(changedPath)).toBe(true);
			expect(matcher.isIgnored(siblingPath)).toBe(false);

			fs.unlinkSync(ignorePath);
			invalidateProjectIgnoreMatcherForPath(ignorePath);
			expect(matcher.isIgnored(changedPath)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("refreshes a nested .gitignore in a non-git tree", () => {
		const env = setupTestEnvironment("pi-lens-2071-no-git-");
		try {
			const nested = path.join(env.tmpDir, "packages", "app");
			fs.mkdirSync(nested, { recursive: true });
			const ignoredPath = path.join(nested, "generated.ts");
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(ignoredPath)).toBe(true);

			fs.writeFileSync(ignorePath, "!generated.ts\n");
			invalidateProjectIgnoreMatcherForPath(ignorePath);
			expect(matcher.isIgnored(ignoredPath)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("refreshes an outer matcher when a nested git root changes", () => {
		const env = setupTestEnvironment("pi-lens-2071-nested-git-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			const nested = path.join(env.tmpDir, "submodule");
			fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
			const ignoredPath = path.join(nested, "generated.ts");
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(ignoredPath)).toBe(true);

			fs.writeFileSync(ignorePath, "!generated.ts\n");
			invalidateProjectIgnoreMatcherForPath(ignorePath);
			expect(matcher.isIgnored(ignoredPath)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("compiles each expanded pattern once per matcher instance across a walk over unique paths", () => {
		const env = setupTestEnvironment("pi-lens-1976-compile-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "*.log\ntemp/\n");
			for (let i = 0; i < 60; i++) {
				createTempFile(env.tmpDir, `f${i}.log`, "");
			}
			for (let i = 0; i < 20; i++) {
				createTempFile(env.tmpDir, `temp/f${i}.ts`, "");
			}
			for (let i = 0; i < 20; i++) {
				createTempFile(env.tmpDir, `s${i}.ts`, "");
			}
			const matcher = createProjectIgnoreMatcher(env.tmpDir);
			const counter = compileCounter();
			// 100 unique paths — the per-path verdict memo never hits, exactly
			// like a first walk over the tree.
			for (let i = 0; i < 60; i++) {
				matcher.isIgnored(path.join(env.tmpDir, `f${i}.log`));
			}
			for (let i = 0; i < 20; i++) {
				matcher.isIgnored(path.join(env.tmpDir, `temp`, `f${i}.ts`));
			}
			for (let i = 0; i < 20; i++) {
				matcher.isIgnored(path.join(env.tmpDir, `s${i}.ts`));
			}
			// `*.log` expands to [*.log, **/*.log]; `temp/` (directory-only,
			// no slash, not rooted) expands to
			// [temp, temp/**, **/temp, **/temp/**] — 6 distinct compiled globs
			// total. Pre-fix this is 100 files × 6 = 600 compilations.
			expect(counter.count).toBeGreaterThanOrEqual(1);
			expect(counter.count).toBeLessThanOrEqual(6);
		} finally {
			env.cleanup();
		}
	});

	it("repeated isIgnored calls on the same path add zero compilations", () => {
		const env = setupTestEnvironment("pi-lens-1976-repeat-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "*.log\n");
			createTempFile(env.tmpDir, "a.log", "");
			const matcher = createProjectIgnoreMatcher(env.tmpDir);
			const counter = compileCounter();
			expect(matcher.isIgnored(path.join(env.tmpDir, "a.log"))).toBe(true);
			const firstPass = counter.count;
			for (let i = 0; i < 25; i++) {
				expect(matcher.isIgnored(path.join(env.tmpDir, "a.log"))).toBe(true);
			}
			expect(counter.count).toBe(firstPass);
		} finally {
			env.cleanup();
		}
	});

	it("a nested .gitignore pattern does not leak to sibling subtrees through the memo (the #1976 trap)", () => {
		const env = setupTestEnvironment("pi-lens-1976-leak-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "*.log\n");
			const sub1 = path.join(env.tmpDir, "sub1");
			const sub2 = path.join(env.tmpDir, "sub2");
			fs.mkdirSync(sub1);
			fs.mkdirSync(sub2);
			fs.writeFileSync(path.join(sub1, ".gitignore"), "profiles/\n*.snap\n");

			const matcher = createProjectIgnoreMatcher(env.tmpDir);
			// Poisoning order: warm sub1 first. A verdict cache keyed by
			// pattern text alone would return sub1's answers for every query
			// below.
			expect(matcher.isIgnored(path.join(sub1, "a.snap"))).toBe(true);
			expect(matcher.isIgnored(path.join(sub1, "profiles"), true)).toBe(true);
			expect(matcher.isIgnored(path.join(sub1, "profiles", "x.ts"))).toBe(true);
			// Sibling subtree: sub1's patterns must NOT apply there.
			expect(matcher.isIgnored(path.join(sub2, "a.snap"))).toBe(false);
			expect(matcher.isIgnored(path.join(sub2, "profiles"), true)).toBe(false);
			expect(matcher.isIgnored(path.join(sub2, "profiles", "x.ts"))).toBe(
				false,
			);
			// Outside both subtrees.
			expect(matcher.isIgnored(path.join(env.tmpDir, "a.snap"))).toBe(false);
			// The root pattern still applies inside the sibling subtree.
			expect(matcher.isIgnored(path.join(sub2, "b.log"))).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("two subtrees sharing a pattern text keep independent verdicts (negation in one subtree only)", () => {
		const env = setupTestEnvironment("pi-lens-1976-shared-");
		try {
			const sub1 = path.join(env.tmpDir, "sub1");
			const sub2 = path.join(env.tmpDir, "sub2");
			fs.mkdirSync(sub1);
			fs.mkdirSync(sub2);
			fs.writeFileSync(path.join(sub1, ".gitignore"), "*.gen.ts\n");
			fs.writeFileSync(
				path.join(sub2, ".gitignore"),
				"*.gen.ts\n!keep.gen.ts\n",
			);

			// sub1 first: the compiled `*.gen.ts` / `**/*.gen.ts` globs are
			// now warm and shared across subtrees — the VERDICT must not be.
			const matcherA = createProjectIgnoreMatcher(env.tmpDir);
			expect(matcherA.isIgnored(path.join(sub1, "keep.gen.ts"))).toBe(true);
			expect(matcherA.isIgnored(path.join(sub2, "keep.gen.ts"))).toBe(false);
			expect(matcherA.isIgnored(path.join(sub2, "drop.gen.ts"))).toBe(true);

			// Reverse order on a fresh matcher: same answers.
			const matcherB = createProjectIgnoreMatcher(env.tmpDir);
			expect(matcherB.isIgnored(path.join(sub2, "keep.gen.ts"))).toBe(false);
			expect(matcherB.isIgnored(path.join(sub1, "keep.gen.ts"))).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("the compile cache is per matcher instance, not process-lifetime (catalog shape 17)", () => {
		const envA = setupTestEnvironment("pi-lens-1976-inst-a-");
		const envB = setupTestEnvironment("pi-lens-1976-inst-b-");
		try {
			fs.writeFileSync(path.join(envA.tmpDir, ".gitignore"), "*.log\n");
			fs.writeFileSync(path.join(envB.tmpDir, ".gitignore"), "*.log\n");
			const a = createProjectIgnoreMatcher(envA.tmpDir);
			const b = createProjectIgnoreMatcher(envB.tmpDir);
			const counter = compileCounter();
			// A NON-matching file exercises every expansion: `*.log` expands
			// to exactly [*.log, **/*.log] (a matching file short-circuits
			// after the first).
			a.isIgnored(path.join(envA.tmpDir, "x.ts"));
			expect(counter.count).toBe(2);
			// A second matcher instance must compile its own: a module-level
			// cache shared across instances would keep the count at 2.
			b.isIgnored(path.join(envB.tmpDir, "x.ts"));
			expect(counter.count).toBe(4);
			// And within one instance the count stays flat no matter how many
			// unique paths are checked.
			for (let i = 0; i < 30; i++) {
				a.isIgnored(path.join(envA.tmpDir, `f${i}.ts`));
			}
			expect(counter.count).toBe(4);
		} finally {
			envA.cleanup();
			envB.cleanup();
		}
	});

	it("rebuilding the matcher (root .gitignore change) drops the compile cache with the instance", () => {
		const env = setupTestEnvironment("pi-lens-1976-inval-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "*.log\n");
			const first = getProjectIgnoreMatcher(env.tmpDir);
			const counter = compileCounter();
			// Non-matching file: compiles both expansions of `*.log`.
			first.isIgnored(path.join(env.tmpDir, "x.ts"));
			expect(counter.count).toBe(2);
			// Different content (size+mtime signature, #1105) rebuilds the
			// matcher; the old instance's compile cache dies with it.
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "*.log\n*.tmp\n");
			const second = getProjectIgnoreMatcher(env.tmpDir);
			expect(second).not.toBe(first);
			second.isIgnored(path.join(env.tmpDir, "x.ts"));
			expect(counter.count).toBeGreaterThan(2);
		} finally {
			env.cleanup();
		}
	});

	// The measured acceptance criterion, in #1974's fixture shape with its
	// order swap already in place: source-extension files ignored only by a
	// FILE-LEVEL pattern, so the extension gate stays open and every file
	// still consults isIgnored — the residue #1974's swap cannot remove and
	// this memo exists to make cheap. Counts, never wall time (#1920).
	it("warmup walk over a file-level-ignored source pile compiles O(patterns), not O(files)", async () => {
		const env = setupTestEnvironment("pi-lens-1976-walk-");
		try {
			const PILE = 200;
			for (let i = 0; i < PILE; i++) {
				createTempFile(env.tmpDir, `wal/gen${i}.gen.ts`, "");
			}
			createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "*.gen.ts\n");

			const counter = compileCounter();
			const files = await collectSourceFilesForWarmup(env.tmpDir);
			const compiles = counter.count;

			expect(
				files.some((f) => f.replace(/\\/g, "/").endsWith("/src/a.ts")),
			).toBe(true);
			expect(files.some((f) => f.endsWith(".gen.ts"))).toBe(false);
			// `*.gen.ts` expands to two globs; the walk's directory queries
			// reuse them. Pre-fix: 200 files × 2 expansions = 400+ compilations.
			expect(compiles).toBeLessThanOrEqual(8);
		} finally {
			env.cleanup();
		}
	});
});
