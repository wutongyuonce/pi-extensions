/**
 * #1974: cheap extension gate must run BEFORE the ignore matcher in every
 * project-wide walker that has one. `isIgnored` is O(ancestorDirs x patterns)
 * with a per-call minimatch regex compile (0.68-0.93ms/file, measured on the
 * reported repro) — a large ignored-but-not-dir-prunable pile (e.g. a
 * `wal/*.log` runtime-output directory, gitignored only by a file-level
 * pattern so the directory itself is never pruned) turned a sub-second walk
 * into a 31.7s one because every dropped file still paid the isIgnored cost.
 *
 * Each block spies on the SAME ignoreMatcher instance the walker uses
 * (`getProjectIgnoreMatcher` caches per resolved root) and proves isIgnored
 * is never called for a file the extension gate would have dropped anyway.
 * Reverting any one site's order reds its own block — this is the
 * mutation-proof pin the ACs call for.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getProjectIgnoreMatcher } from "../../clients/file-utils.js";
import { JscpdClient } from "../../clients/jscpd-client.js";
import { collectSourceFilesForWarmup } from "../../clients/language-profile.js";
import { __collectWorkspaceDiagnosticFilesForTest } from "../../clients/lsp/index.js";
import { getModuleSourceFiles } from "../../clients/review-graph/workspace-modules.js";
import { collectSourceFiles } from "../../clients/source-filter.js";
import { countSourceFilesWithinLimit } from "../../clients/startup-scan.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Extensions none of the four walkers treat as source — the extension gate
// must drop these without ever consulting the ignore matcher.
const NON_SOURCE_NAMES = ["notes.xyz", "data.bin", "cache.tmp"];

function writeNonSourceFixture(root: string): void {
	for (const name of NON_SOURCE_NAMES) {
		createTempFile(root, name, "not source\n");
	}
	// A source file, so the walk has something to actually collect too.
	createTempFile(root, "src/a.ts", "export const a = 1;\n");
}

function isIgnoredCallsForNonSourceFiles(spy: {
	mock: { calls: [string, boolean?][] };
}): unknown[] {
	return spy.mock.calls.filter(([filePath, isDirectory]) => {
		if (isDirectory) return false;
		const base = path.basename(String(filePath));
		return NON_SOURCE_NAMES.includes(base);
	});
}

describe("#1974 extension gate runs before isIgnored", () => {
	it("collectSourceFilesForWarmup (language-profile.ts) never calls isIgnored for an extension-dropped file", async () => {
		const env = setupTestEnvironment("pi-lens-1974-warmup-");
		try {
			writeNonSourceFixture(env.tmpDir);
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			const spy = vi.spyOn(matcher, "isIgnored");

			const files = (await collectSourceFilesForWarmup(env.tmpDir)).map((f) =>
				f.replace(/\\/g, "/"),
			);

			expect(files.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(isIgnoredCallsForNonSourceFiles(spy)).toHaveLength(0);
			spy.mockRestore();
		} finally {
			env.cleanup();
		}
	});

	it("JscpdClient's hasSourceFilesRecursive never calls isIgnored for an extension-dropped file", () => {
		const env = setupTestEnvironment("pi-lens-1974-jscpd-");
		try {
			writeNonSourceFixture(env.tmpDir);
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			const spy = vi.spyOn(matcher, "isIgnored");

			const client = new JscpdClient(false) as unknown as {
				hasSourceFilesRecursive: (dir: string) => boolean;
			};
			const found = client.hasSourceFilesRecursive(env.tmpDir);

			expect(found).toBe(true);
			expect(isIgnoredCallsForNonSourceFiles(spy)).toHaveLength(0);
			spy.mockRestore();
		} finally {
			env.cleanup();
		}
	});

	it("collectSourceFiles (source-filter.ts) never calls isIgnored for an extension-dropped file", () => {
		const env = setupTestEnvironment("pi-lens-1974-filter-");
		try {
			writeNonSourceFixture(env.tmpDir);
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			const spy = vi.spyOn(matcher, "isIgnored");

			const files = collectSourceFiles(env.tmpDir).map((f) =>
				f.replace(/\\/g, "/"),
			);

			expect(files.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(isIgnoredCallsForNonSourceFiles(spy)).toHaveLength(0);
			spy.mockRestore();
		} finally {
			env.cleanup();
		}
	});

	it("countSourceFilesWithinLimit (startup-scan.ts) never calls isIgnored for an extension-dropped file", () => {
		const env = setupTestEnvironment("pi-lens-1974-startup-");
		try {
			writeNonSourceFixture(env.tmpDir);
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			const spy = vi.spyOn(matcher, "isIgnored");

			const count = countSourceFilesWithinLimit(env.tmpDir, 100);

			expect(count).toBe(1);
			expect(isIgnoredCallsForNonSourceFiles(spy)).toHaveLength(0);
			spy.mockRestore();
		} finally {
			env.cleanup();
		}
	});

	// Class-sweep additions (#1974 review round): the reporter's four sites plus
	// two more bulk walks found by the follow-up sweep across all 14 files that
	// call isIgnored. See the PR body's per-site table for the full population.
	it("getModuleSourceFiles (review-graph/workspace-modules.ts) never calls isIgnored for an extension-dropped file", () => {
		const env = setupTestEnvironment("pi-lens-1974-modules-");
		try {
			writeNonSourceFixture(env.tmpDir);
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			const spy = vi.spyOn(matcher, "isIgnored");

			const files = getModuleSourceFiles(env.tmpDir, 100).map((f) =>
				f.replace(/\\/g, "/"),
			);

			expect(files.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(isIgnoredCallsForNonSourceFiles(spy)).toHaveLength(0);
			spy.mockRestore();
		} finally {
			env.cleanup();
		}
	});

	it("collectWorkspaceDiagnosticFiles (lsp/index.ts) never calls isIgnored for a file with no matching LSP server", async () => {
		const env = setupTestEnvironment("pi-lens-1974-lsp-diag-");
		try {
			writeNonSourceFixture(env.tmpDir);
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			const spy = vi.spyOn(matcher, "isIgnored");

			const files = (
				await __collectWorkspaceDiagnosticFilesForTest(env.tmpDir, 100)
			).map((f) => f.replace(/\\/g, "/"));

			expect(files.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(isIgnoredCallsForNonSourceFiles(spy)).toHaveLength(0);
			spy.mockRestore();
		} finally {
			env.cleanup();
		}
	});

	it("output identity: same collected set before/after, on a fixture with ignored source files, non-ignored non-source files, and an ignored wal/*.log-shaped pile", async () => {
		const env = setupTestEnvironment("pi-lens-1974-identity-");
		try {
			// Ignored source file (gitignore pattern below).
			createTempFile(env.tmpDir, "build/out.ts", "export const b = 1;\n");
			// Non-ignored non-source file (no walker treats .bin as source).
			createTempFile(env.tmpDir, "notes.bin", "binary\n");
			// wal/*.log shape: file-level ignore pattern, directory not prunable.
			for (let i = 0; i < 20; i++) {
				createTempFile(env.tmpDir, `wal/seg${i}.log`, "");
			}
			// A real, non-ignored source file that must survive.
			createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "build/\n*.log\n");

			const warmupFiles = (await collectSourceFilesForWarmup(env.tmpDir))
				.map((f) => f.replace(/\\/g, "/"))
				.filter((f) => !f.endsWith("/.gitignore"));
			expect(warmupFiles.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(warmupFiles.some((f) => f.includes("/build/"))).toBe(false);
			expect(warmupFiles.some((f) => f.endsWith(".log"))).toBe(false);
			expect(warmupFiles.some((f) => f.endsWith("/notes.bin"))).toBe(false); // not a WARMUP_SOURCE_EXTS extension

			const filterFiles = collectSourceFiles(env.tmpDir).map((f) =>
				f.replace(/\\/g, "/"),
			);
			expect(filterFiles.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(filterFiles.some((f) => f.includes("/build/"))).toBe(false);
			expect(filterFiles.some((f) => f.endsWith(".log"))).toBe(false);

			const sourceCount = countSourceFilesWithinLimit(env.tmpDir, 100);
			// Only src/a.ts matches SOURCE_FILE_PATTERN and is not ignored.
			expect(sourceCount).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// AC3 is measured in isIgnored call count, not wall-clock time — a real-clock
	// CI assertion flakes under machine load (the #1920 lesson). The reported
	// repro's cost is dominated by one isIgnored call per file in a large
	// ignored-but-not-dir-prunable pile; this fixture reproduces that shape at a
	// scale a unit test can afford and proves the walk pays isIgnored only for
	// the one file that is actually source, not for the pile.
	it("fixture-scale sanity: a large ignored non-source pile costs O(source files), not O(pile size), in isIgnored calls", async () => {
		const env = setupTestEnvironment("pi-lens-1974-scale-");
		try {
			const PILE_SIZE = 500;
			for (let i = 0; i < PILE_SIZE; i++) {
				createTempFile(env.tmpDir, `wal/seg${i}.log`, "");
			}
			createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "*.log\n");

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			const spy = vi.spyOn(matcher, "isIgnored");

			await collectSourceFilesForWarmup(env.tmpDir);

			const fileCalls = spy.mock.calls.filter(
				([, isDirectory]) => !isDirectory,
			);
			// Pre-fix: one isIgnored call per file in the pile (PILE_SIZE + 1).
			// Post-fix: the extension gate drops every .log file before isIgnored
			// runs, so only the one .ts file is ever checked.
			expect(fileCalls.length).toBeLessThan(PILE_SIZE / 10);
			spy.mockRestore();
		} finally {
			env.cleanup();
		}
	});
});
