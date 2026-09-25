import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { LANGUAGE_TO_GRAMMAR } from "../../../clients/grammar-source.js";
import { loadProjectDiagnosticsSnapshot } from "../../../clients/project-diagnostics/cache.js";
import {
	scanProjectDiagnostics,
	TREE_SITTER_EXT_TO_LANG,
} from "../../../clients/project-diagnostics/scanner.js";
import {
	getQueryLanguageKey,
	isDisabledQueryDirectoryName,
} from "../../../clients/tree-sitter-query-loader.js";
import {
	_resetSharedTreeSitterClientForTests,
	EXT_TO_LANG,
	getSharedTreeSitterClient,
} from "../../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "../test-utils.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scanner-"));
});

afterEach(() => {
	removeTempDirSync(tmp);
});

describe("TREE_SITTER_EXT_TO_LANG scan coverage (#882)", () => {
	const REPO_ROOT = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../..",
	);
	const QUERIES_DIR = path.join(REPO_ROOT, "rules", "tree-sitter-queries");

	// Every non-disabled rules/tree-sitter-queries/<lang>/ dir whose <lang> is a
	// loadable grammar. These are the languages a project scan CAN and SHOULD run
	// tree-sitter rules for.
	const ruleLanguagesWithGrammar = fs
		.readdirSync(QUERIES_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !isDisabledQueryDirectoryName(d.name))
		.filter((d) =>
			fs
				.readdirSync(path.join(QUERIES_DIR, d.name))
				.some((f) => f.endsWith(".yml")),
		)
		.map((d) => getQueryLanguageKey(d.name))
		.filter((lang) => lang in LANGUAGE_TO_GRAMMAR);

	const coveredLangs = new Set(Object.values(TREE_SITTER_EXT_TO_LANG));

	// The regression guard for #882: a language that has rules + a grammar but no
	// extension in the scanner map is silently skipped by every project scan. If a
	// future rule dir is added, this fails until its extension is registered.
	it.each([...new Set(ruleLanguagesWithGrammar)].sort())(
		"scans every rule language with a loadable grammar: %s",
		(lang) => {
			expect(coveredLangs.has(lang)).toBe(true);
		},
	);

	it("covers the languages #882 called out (java, kotlin, csharp, cpp, css, php, c)", () => {
		for (const lang of ["java", "kotlin", "csharp", "cpp", "css", "php", "c"]) {
			expect(coveredLangs.has(lang)).toBe(true);
		}
	});

	it("stays a superset of the shared per-edit resolver so the two can't drift", () => {
		// The scanner map derives EXT_TO_LANG, then layers java/kotlin on top — so
		// every per-edit-resolvable extension must resolve identically in a scan.
		for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
			expect(TREE_SITTER_EXT_TO_LANG[ext]).toBe(lang);
		}
	});

	it("only maps extensions to loadable grammars", () => {
		for (const lang of coveredLangs) {
			expect(lang in LANGUAGE_TO_GRAMMAR).toBe(true);
		}
	});
});

describe("scanProjectDiagnostics home ceiling (#747/#250)", () => {
	// The cheap tier is file-capped, but from a cwd at/above $HOME it still walks
	// a huge unrelated tree until it keeps that many source files. Refuse to walk.
	it("refuses to walk when cwd IS the home directory", async () => {
		const snapshot = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			homeDir: tmp,
		});

		expect(snapshot.unsafeRoot).toBe(true);
		expect(snapshot.filesScanned).toBe(0);
		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.runners).toEqual([]);
	});

	it("refuses to walk when cwd is an ANCESTOR of the home directory", async () => {
		const fakeHome = path.join(tmp, "home", "user");
		fs.mkdirSync(fakeHome, { recursive: true });

		const snapshot = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			homeDir: fakeHome,
		});

		expect(snapshot.unsafeRoot).toBe(true);
	});

	it("does NOT persist the refusal snapshot to the cross-session cache", async () => {
		await scanProjectDiagnostics({ cwd: tmp, tier: "cheap", homeDir: tmp });
		// A refusal must not poison the cache — a later cached read would wrongly
		// trust it as a complete, clean scan.
		expect(loadProjectDiagnosticsSnapshot(tmp)).toBeUndefined();
	});

	it("scans normally for a project directory UNDER the home directory", async () => {
		const fakeHome = path.join(tmp, "home", "user");
		const project = path.join(fakeHome, "code", "app");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "index.ts"), "export const x = 1;\n");

		const snapshot = await scanProjectDiagnostics({
			cwd: project,
			tier: "cheap",
			homeDir: fakeHome,
		});

		expect(snapshot.unsafeRoot).toBeUndefined();
		expect(snapshot.filesScanned).toBeGreaterThanOrEqual(1);
	});

	it("flags scanTruncated (without refusing) when the walk's entry budget trips (#760)", async () => {
		const fakeHome = path.join(tmp, "home", "user");
		const project = path.join(fakeHome, "code", "app");
		fs.mkdirSync(project, { recursive: true });
		// Mixed tree: real source buried among non-source data files so a tiny
		// visited-entry budget trips while the maxFiles results cap never would.
		fs.writeFileSync(path.join(project, "index.ts"), "export const x = 1;\n");
		for (let i = 0; i < 30; i++) {
			fs.writeFileSync(path.join(project, `blob-${i}.dat`), "not source\n");
		}

		const snapshot = await scanProjectDiagnostics({
			cwd: project,
			tier: "cheap",
			homeDir: fakeHome,
			maxScanEntries: 5,
		});

		// Truncation is surfaced but is NOT a refusal — the partial scan ran.
		expect(snapshot.scanTruncated).toBe(true);
		expect(snapshot.unsafeRoot).toBeUndefined();
		expect(snapshot.runners.length).toBeGreaterThan(0);
	});

	it("omits scanTruncated entirely on an untruncated scan", async () => {
		const fakeHome = path.join(tmp, "home", "user");
		const project = path.join(fakeHome, "code", "app");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "index.ts"), "export const x = 1;\n");

		const snapshot = await scanProjectDiagnostics({
			cwd: project,
			tier: "cheap",
			homeDir: fakeHome,
		});

		expect(snapshot.scanTruncated).toBeUndefined();
	});

	it("does not refuse an explicit `files` scan even at home (subset, not a walk)", async () => {
		const file = path.join(tmp, "index.ts");
		fs.writeFileSync(file, "export const x = 1;\n");

		const snapshot = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			homeDir: tmp,
			files: [file],
		});

		expect(snapshot.unsafeRoot).toBeUndefined();
	});
});

describe("scanProjectDiagnostics FactStore lifecycle (#886, #939)", () => {
	it("releases every file fact after its consumers finish", async () => {
		const files = ["a.ts", "b.ts", "c.ts"].map((name, index) => {
			const filePath = path.join(tmp, name);
			fs.writeFileSync(
				filePath,
				`export const value${index} = "${name}-full-content-marker";\n`,
			);
			return filePath;
		});
		const released = new Set<string>();
		const occupiedFiles = new Set<string>();
		let peakOccupiedFiles = 0;
		const originalSet = FactStore.prototype.setFileFact;
		const setSpy = vi
			.spyOn(FactStore.prototype, "setFileFact")
			.mockImplementation(function (
				this: FactStore,
				filePath: string,
				factId: string,
				value: unknown,
			) {
				originalSet.call(this, filePath, factId, value);
				occupiedFiles.add(path.resolve(filePath));
				peakOccupiedFiles = Math.max(peakOccupiedFiles, occupiedFiles.size);
			});
		// #2243: the scan releases each file's facts through dropFileFacts (clear
		// without pinning), so the capacity cap stays effective on its own store.
		const originalClear = FactStore.prototype.dropFileFacts;
		const clearSpy = vi
			.spyOn(FactStore.prototype, "dropFileFacts")
			.mockImplementation(function (this: FactStore, filePath: string) {
				const resolved = path.resolve(filePath);
				const hadContent = this.hasFileFact(filePath, "file.content");
				originalClear.call(this, filePath);
				if (hadContent) {
					expect(this.hasFileFact(filePath, "file.content")).toBe(false);
					released.add(resolved);
				}
				occupiedFiles.delete(resolved);
			});

		try {
			await scanProjectDiagnostics({
				cwd: tmp,
				tier: "cheap",
				files,
			});
		} finally {
			clearSpy.mockRestore();
			setSpy.mockRestore();
		}

		expect(released).toEqual(new Set(files.map((file) => path.resolve(file))));
		expect(peakOccupiedFiles).toBe(1);
		expect(occupiedFiles.size).toBe(0);
	});
});

describe("scanProjectDiagnostics tree-cache reuse across scans (#1715)", () => {
	afterEach(() => _resetSharedTreeSitterClientForTests());

	it("grows the tree cache past the 110-file working set so a second identical scan hits, not re-parses", async () => {
		const fileCount = 110;
		const files = Array.from({ length: fileCount }, (_, i) => {
			const filePath = path.join(tmp, `f${i}.ts`);
			fs.writeFileSync(filePath, `export const v${i} = ${i};\n`);
			return filePath;
		});

		await scanProjectDiagnostics({ cwd: tmp, tier: "all", files });
		const client = getSharedTreeSitterClient();
		expect(client).not.toBeNull();
		// First scan is necessarily cold — this is the pre-condition, not the
		// claim under test.
		const afterFirst = client?.getParseCacheStats();
		expect(afterFirst?.size).toBe(fileCount);

		await scanProjectDiagnostics({ cwd: tmp, tier: "all", files });
		const afterSecond = client?.getParseCacheStats();

		// The live dogfood measurement behind #1715: a fixed 50-entry cache
		// makes EVERY second-scan miss a capacityMiss. Fixed, the second scan
		// should find every file still resident — zero capacity misses.
		expect(afterSecond?.capacityMisses).toBe(0);
	}, 30000);
});
