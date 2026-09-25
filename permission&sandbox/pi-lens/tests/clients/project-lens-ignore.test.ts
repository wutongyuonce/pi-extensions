import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createProjectIgnoreMatcher,
	getProjectIgnoreMatcher,
	PROJECT_IGNORE_FRESHNESS_CADENCE_MS,
} from "../../clients/file-utils.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "../../clients/source-filter.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-ignore-"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	vi.useRealTimers();
	removeTempDirSync(tmpDir);
	resetProjectLensConfigCache();
});

describe("createProjectIgnoreMatcher with project config", () => {
	it("createProjectIgnoreMatcher honors extraPatterns as before", () => {
		// Sanity: the existing extension point still works. The new code path
		// just wires `.pi-lens.json` content into it via getProjectIgnoreMatcher.
		const matcher = createProjectIgnoreMatcher(tmpDir, ["vendor/**"]);
		expect(matcher.isIgnored(path.join(tmpDir, "vendor/foo.ts"), false)).toBe(
			true,
		);
		expect(matcher.isIgnored(path.join(tmpDir, "src/foo.ts"), false)).toBe(
			false,
		);
	});

	it("getProjectIgnoreMatcher picks up ignore patterns from .pi-lens.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["**/skip-this/**", "noise.ts"] }),
		);
		fs.mkdirSync(path.join(tmpDir, "skip-this"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "keep-this"), { recursive: true });

		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(matcher.isIgnored(path.join(tmpDir, "skip-this/x.ts"), false)).toBe(
			true,
		);
		expect(matcher.isIgnored(path.join(tmpDir, "noise.ts"), false)).toBe(true);
		expect(matcher.isIgnored(path.join(tmpDir, "keep-this/y.ts"), false)).toBe(
			false,
		);
	});

	it("getProjectIgnoreMatcher still honors .gitignore alongside .pi-lens.json", () => {
		fs.writeFileSync(path.join(tmpDir, ".gitignore"), "gitignored/\n");
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["project-ignored/**"] }),
		);
		fs.mkdirSync(path.join(tmpDir, "gitignored"));
		fs.mkdirSync(path.join(tmpDir, "project-ignored"));

		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(matcher.isIgnored(path.join(tmpDir, "gitignored/x.ts"), false)).toBe(
			true,
		);
		expect(
			matcher.isIgnored(path.join(tmpDir, "project-ignored/x.ts"), false),
		).toBe(true);
	});

	it("project ignore patterns support gitignore negation", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["fixtures/**", "!fixtures/keep.ts"] }),
		);

		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(
			matcher.isIgnored(path.join(tmpDir, "fixtures/noise.ts"), false),
		).toBe(true);
		expect(
			matcher.isIgnored(path.join(tmpDir, "fixtures/keep.ts"), false),
		).toBe(false);
	});

	it("getProjectIgnoreMatcher returns a clean matcher when no project config exists", () => {
		// No .pi-lens.json and no .gitignore — should not throw, just return
		// a matcher that ignores nothing.
		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(matcher.isIgnored(path.join(tmpDir, "anything.ts"), false)).toBe(
			false,
		);
	});

	it("getProjectIgnoreMatcher cache invalidates when .pi-lens.json changes", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["first/**"] }),
		);
		fs.mkdirSync(path.join(tmpDir, "first"));
		fs.mkdirSync(path.join(tmpDir, "second"));

		const before = getProjectIgnoreMatcher(tmpDir);
		expect(before.isIgnored(path.join(tmpDir, "first/x.ts"), false)).toBe(true);
		expect(before.isIgnored(path.join(tmpDir, "second/x.ts"), false)).toBe(
			false,
		);

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["second/**"] }),
		);

		const after = getProjectIgnoreMatcher(tmpDir);
		expect(after.isIgnored(path.join(tmpDir, "first/x.ts"), false)).toBe(false);
		expect(after.isIgnored(path.join(tmpDir, "second/x.ts"), false)).toBe(true);
	});

	it("invalidates when inherited parent .pi-lens.json changes above the git root", async () => {
		const childRoot = path.join(tmpDir, "nested-repo");
		fs.mkdirSync(path.join(childRoot, ".git"), { recursive: true });
		fs.mkdirSync(path.join(childRoot, "first"));
		fs.mkdirSync(path.join(childRoot, "second"));
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["first/**"] }),
		);

		const before = getProjectIgnoreMatcher(childRoot);
		expect(before.isIgnored(path.join(childRoot, "first/x.ts"), false)).toBe(
			true,
		);
		expect(before.isIgnored(path.join(childRoot, "second/x.ts"), false)).toBe(
			false,
		);

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["second/**"] }),
		);

		const after = getProjectIgnoreMatcher(childRoot);
		expect(after.isIgnored(path.join(childRoot, "first/x.ts"), false)).toBe(
			false,
		);
		expect(after.isIgnored(path.join(childRoot, "second/x.ts"), false)).toBe(
			true,
		);
	});

	function writeSourceCollectionFixture(): void {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["fixtures/**"] }),
		);
		const fixturesDir = path.join(tmpDir, "fixtures");
		fs.mkdirSync(fixturesDir);
		fs.writeFileSync(
			path.join(fixturesDir, "noise.ts"),
			"export const x = 1;\n",
		);
		const srcDir = path.join(tmpDir, "src");
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, "real.ts"), "export const y = 2;\n");
	}

	function relativeUnixPaths(files: string[]): string[] {
		return files.map((f) => path.relative(tmpDir, f).replace(/\\/g, "/"));
	}

	it("project ignore patterns feed through collectSourceFiles", () => {
		// End-to-end: a path that the project config ignores must not appear in
		// the source file listing that drives every per-edit scan.
		writeSourceCollectionFixture();

		const rel = relativeUnixPaths(collectSourceFiles(tmpDir));
		expect(rel).toContain("src/real.ts");
		expect(rel).not.toContain("fixtures/noise.ts");
	});

	it("project ignore patterns feed through collectSourceFilesAsync", async () => {
		writeSourceCollectionFixture();

		const rel = relativeUnixPaths(await collectSourceFilesAsync(tmpDir));
		expect(rel).toContain("src/real.ts");
		expect(rel).not.toContain("fixtures/noise.ts");
	});
});

describe("ignore-matcher cache freshness (#1105 mtime+size)", () => {
	// The project-ignore matcher cache short-circuits on the config file's mtime
	// alone before #1105 — so an in-place `.pi-lens.json` edit that preserves
	// mtime (git checkout, same-second rewrite) but changes length replayed a
	// stale matcher, even though the underlying parsed-config cache was fixed.
	// Both writes are pinned to the SAME mtime, isolating the size axis. This is
	// a SEPARATE gate from loadPiLensProjectConfig's: the matcher cache returns
	// before ever consulting the config parse cache, so it needs its own size
	// check. FS-agnostic → runs identically on Linux CI (#1024).
	it("rebuilds the matcher on an mtime-preserving, length-changing edit", () => {
		const configPath = path.join(tmpDir, ".pi-lens.json");
		const pinned = new Date("2020-01-01T00:00:00.000Z");

		// Longer config first (two ignore entries).
		fs.writeFileSync(
			configPath,
			JSON.stringify({ ignore: ["**/skip-old/**", "**/also-skip/**"] }),
		);
		fs.utimesSync(configPath, pinned, pinned);
		const first = getProjectIgnoreMatcher(tmpDir);
		expect(first.isIgnored(path.join(tmpDir, "skip-old/x.ts"), false)).toBe(
			true,
		);

		// Shorter, different config; restore the SAME mtime.
		fs.writeFileSync(
			configPath,
			JSON.stringify({ ignore: ["**/skip-new/**"] }),
		);
		fs.utimesSync(configPath, pinned, pinned);

		const second = getProjectIgnoreMatcher(tmpDir);
		expect(second.isIgnored(path.join(tmpDir, "skip-new/y.ts"), false)).toBe(
			true,
		);
		// The stale rule no longer applies once the matcher is rebuilt.
		expect(second.isIgnored(path.join(tmpDir, "skip-old/x.ts"), false)).toBe(
			false,
		);
	});

	// Nested-config path (#783 layering). The nested cache in `patternsForDir`
	// short-circuits AHEAD of the root config/matcher caches: a NESTED
	// `.pi-lens.json`/`.gitignore` change leaves the ROOT signatures unchanged, so
	// the root matcher cache HITS and returns the SAME matcher instance — the
	// nested cache is then the only gate deciding freshness for that subtree.
	// Because the matcher (and its per-path `patternMemo`) is reused, the
	// post-edit assertions use FRESH paths never queried before, so they exercise
	// `patternsForDir` (and the nested cache) rather than a memoized verdict.
	// A `.git` marker anchors `resolveGitIgnoreRoot` at tmpDir so the sub dir is a
	// genuine nested ancestor. Pre-#1105 (mtime-only nested gate) these replayed
	// stale patterns for the subtree. FS-agnostic → identical on Linux CI (#1024).
	it("rebuilds nested .pi-lens.json patterns on an mtime-preserving, length-changing edit", () => {
		fs.mkdirSync(path.join(tmpDir, ".git"));
		const subDir = path.join(tmpDir, "pkg");
		fs.mkdirSync(subDir);
		const nestedConfig = path.join(subDir, ".pi-lens.json");
		const pinned = new Date("2020-01-01T00:00:00.000Z");

		// Longer nested ignore list first.
		fs.writeFileSync(
			nestedConfig,
			JSON.stringify({ ignore: ["skip-old/**", "also-skip/**"] }),
		);
		fs.utimesSync(nestedConfig, pinned, pinned);
		const matcher = getProjectIgnoreMatcher(tmpDir);
		// Populate the nested cache for `subDir` (and the memo for this one path).
		expect(matcher.isIgnored(path.join(subDir, "skip-old/x.ts"), false)).toBe(
			true,
		);

		// Shorter, different nested config; restore the SAME mtime. Root config is
		// untouched, so the same matcher instance keeps serving `subDir`.
		fs.writeFileSync(nestedConfig, JSON.stringify({ ignore: ["skip-new/**"] }));
		fs.utimesSync(nestedConfig, pinned, pinned);

		// #2071: the nested rules and the verdicts derived from them now share one
		// clock, so the gate re-checks at window expiry rather than per call. The
		// size axis under test is unchanged; only when it is consulted moved.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

		// Fresh paths → bypass patternMemo → hit the nested cache gate.
		expect(matcher.isIgnored(path.join(subDir, "skip-new/y.ts"), false)).toBe(
			true,
		);
		expect(matcher.isIgnored(path.join(subDir, "skip-old/z.ts"), false)).toBe(
			false,
		);
	});

	it("rebuilds nested .gitignore patterns on an mtime-preserving, length-changing edit", () => {
		fs.mkdirSync(path.join(tmpDir, ".git"));
		const subDir = path.join(tmpDir, "pkg");
		fs.mkdirSync(subDir);
		const nestedGitignore = path.join(subDir, ".gitignore");
		const pinned = new Date("2020-01-01T00:00:00.000Z");

		// Longer nested .gitignore first.
		fs.writeFileSync(nestedGitignore, "old-dir/\nextra-dir/\n");
		fs.utimesSync(nestedGitignore, pinned, pinned);
		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(matcher.isIgnored(path.join(subDir, "old-dir/x.ts"), false)).toBe(
			true,
		);

		// Shorter, different .gitignore; restore the SAME mtime.
		fs.writeFileSync(nestedGitignore, "new-dir/\n");
		fs.utimesSync(nestedGitignore, pinned, pinned);

		// #2071: same shared clock as the .pi-lens.json case above.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

		// Fresh paths → bypass patternMemo → hit the nested cache gate.
		expect(matcher.isIgnored(path.join(subDir, "new-dir/y.ts"), false)).toBe(
			true,
		);
		expect(matcher.isIgnored(path.join(subDir, "old-dir/z.ts"), false)).toBe(
			false,
		);
	});
});
