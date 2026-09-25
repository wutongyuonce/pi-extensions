/**
 * #2521 (reported by @Stark-X) — a turn-end advisory must never name a
 * project-data path it made up.
 *
 * `formatActionableWarningsAdvisory` emitted a hardcoded
 * `.pi-lens/cache/actionable-warnings.json`. That spelling is correct ONLY in
 * `getProjectDataDir`'s legacy arm (a project that already has a `.pi-lens/`
 * directory). In every other project — the common case — the report is written
 * to `~/.pi-lens/projects/<slug>/cache/`, so an agent following the advisory
 * literally ran `cat .pi-lens/cache/actionable-warnings.json` and got
 * `No such file or directory` while the report sat unread. The code-quality
 * advisory carried the identical defect one cache key over.
 *
 * These tests drive the PRODUCTION pairing — `publishActionableWarningsReport`
 * (or `writeCodeQualityWarningsReport`) followed immediately by the formatter,
 * exactly as `handleTurnEnd` does in `clients/runtime-turn.ts` — and then
 * FOLLOW the advised path from the project cwd. The acceptance criterion is
 * the reporter's: following the advisory reaches the generated report.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	formatActionableWarningsAdvisory,
	publishActionableWarningsReport,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	buildCodeQualityWarningsReport,
	formatCodeQualityWarningsAdvisory,
	recordFromCodeQualityDiagnostic,
	writeCodeQualityWarningsReport,
} from "../../clients/code-quality-warnings.js";
import {
	displayProjectDataPath,
	getProjectDataDir,
} from "../../clients/file-utils.js";
import { removeTempDirSync } from "./test-utils.js";

/** The advised path, resolved the way an agent sitting in `cwd` would. */
function followAdvisedPath(cwd: string, advised: string): string {
	const expanded = advised.startsWith("~")
		? path.join(os.homedir(), advised.slice(1))
		: advised;
	return path.resolve(cwd, expanded);
}

/**
 * Windows paths are case-insensitive, and the temp roots these tests compose
 * from (`os.tmpdir()`, the vitest-pinned `PI_LENS_HOME`) are not guaranteed to
 * agree on casing with a `realpathSync`'d project dir. Compare the way the
 * filesystem does.
 */
function expectSamePath(actual: string, expected: string): void {
	const fold = (p: string): string =>
		process.platform === "win32"
			? path.resolve(p).toLowerCase()
			: path.resolve(p);
	expect(fold(actual)).toBe(fold(expected));
}

/**
 * The one line of an advisory that names the raw report. Pulled out by its
 * label rather than by index so a later reordering of the advisory body does
 * not silently make these assertions vacuous.
 */
function advisedRawPath(advisory: string): string {
	const line = advisory.split("\n").find((l) => l.startsWith("Raw report"));
	expect(line, `advisory names no raw report:\n${advisory}`).toBeDefined();
	return (line as string).slice((line as string).indexOf(": ") + 2).trim();
}

function makeReport(cwd: string, file: string): ActionableWarningsReport {
	const filePath = path.join(cwd, file);
	return {
		generatedAt: new Date().toISOString(),
		scope: "turn_delta",
		sessionId: "s-2521",
		turnIndex: 1,
		deltaOnly: true,
		files: [
			{
				filePath,
				displayPath: file,
				warnings: [
					{
						id: "aw:2521test",
						filePath,
						displayPath: file,
						line: 1,
						column: 1,
						severity: "warning",
						tool: "oxlint",
						source: "oxlint",
						rule: "no-unused-vars",
						message: "unused variable",
						actions: [],
						suppressed: false,
						origin: "dispatch",
					},
				],
			},
		],
		summary: {
			warnings: 1,
			unsuppressed: 1,
			suppressed: 0,
			files: 1,
			autoFixEligible: 0,
			byTier: { warning: 1, info: 0, hint: 0 },
		},
	} as unknown as ActionableWarningsReport;
}

/** A temp project plus one source file. No `.pi-lens/` unless asked for. */
function makeProject(label: string, withLegacyDir: boolean): string {
	const cwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-2521-${label}-`)),
	);
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
	if (withLegacyDir) fs.mkdirSync(path.join(cwd, ".pi-lens"));
	return cwd;
}

describe("#2521 turn-end advisories name the RESOLVED project-data path", () => {
	const savedDataDir = process.env.PILENS_DATA_DIR;

	beforeEach(() => {
		delete process.env.PILENS_DATA_DIR;
	});
	afterEach(() => {
		if (savedDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = savedDataDir;
	});

	// The reporter's exact scenario: a fresh project, no legacy directory, no
	// PILENS_DATA_DIR. Pre-fix this said `.pi-lens/cache/...`, which does not
	// exist under `cwd`.
	it("a project with NO legacy .pi-lens directory: following the advisory reaches the report", () => {
		const cwd = makeProject("nolegacy", false);
		try {
			const published = publishActionableWarningsReport(
				new CacheManager(false),
				cwd,
				makeReport(cwd, "src/a.ts"),
				{ origin: "in-band" },
			);
			const advisory = formatActionableWarningsAdvisory(
				published.report,
				cwd,
			) as string;
			expect(advisory).toBeDefined();

			const advised = advisedRawPath(advisory);
			// The bug, stated as an assertion: the advised path must not be the
			// legacy spelling when the store is not the legacy directory.
			expect(fs.existsSync(path.join(cwd, ".pi-lens"))).toBe(false);
			expect(advised).not.toBe(".pi-lens/cache/actionable-warnings.json");

			const followed = followAdvisedPath(cwd, advised);
			expectSamePath(
				followed,
				path.join(getProjectDataDir(cwd), "cache", "actionable-warnings.json"),
			);
			expect(fs.existsSync(followed)).toBe(true);
			expect(
				JSON.parse(fs.readFileSync(followed, "utf8")).summary.unsuppressed,
			).toBe(1);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// The legacy arm still renders the short, cwd-relative spelling — the fix
	// must not make every project print an absolute home path.
	it("a project WITH a legacy .pi-lens directory keeps the relative spelling and still resolves", () => {
		const cwd = makeProject("legacy", true);
		try {
			const published = publishActionableWarningsReport(
				new CacheManager(false),
				cwd,
				makeReport(cwd, "src/a.ts"),
				{ origin: "in-band" },
			);
			const advisory = formatActionableWarningsAdvisory(
				published.report,
				cwd,
			) as string;
			const advised = advisedRawPath(advisory);
			expect(advised).toBe(".pi-lens/cache/actionable-warnings.json");
			expect(fs.existsSync(followAdvisedPath(cwd, advised))).toBe(true);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	it("a custom PILENS_DATA_DIR: the advisory follows the override, not the legacy dir", () => {
		const cwd = makeProject("datadir", true); // legacy dir present AND ignored
		const dataDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2521-store-")),
		);
		try {
			process.env.PILENS_DATA_DIR = dataDir;
			const published = publishActionableWarningsReport(
				new CacheManager(false),
				cwd,
				makeReport(cwd, "src/a.ts"),
				{ origin: "in-band" },
			);
			const advisory = formatActionableWarningsAdvisory(
				published.report,
				cwd,
			) as string;
			const advised = advisedRawPath(advisory);
			expect(advised).not.toBe(".pi-lens/cache/actionable-warnings.json");
			const followed = followAdvisedPath(cwd, advised);
			expectSamePath(
				followed,
				path.join(getProjectDataDir(cwd), "cache", "actionable-warnings.json"),
			);
			expect(fs.existsSync(followed)).toBe(true);
		} finally {
			removeTempDirSync(cwd);
			removeTempDirSync(dataDir);
		}
	});

	// The tool route is the PRIMARY instruction (#2521 maintainer comment):
	// an agent that uses it never has to know the cache layout at all.
	it("leads with the lens_diagnostics route and frames the raw file as a fallback", () => {
		const cwd = makeProject("route", false);
		try {
			const advisory = formatActionableWarningsAdvisory(
				makeReport(cwd, "src/a.ts"),
				cwd,
			) as string;
			const lines = advisory.split("\n");
			const toolLine = lines.findIndex((l) =>
				l.includes("lens_diagnostics with mode=delta"),
			);
			const rawLine = lines.findIndex((l) => l.startsWith("Raw report"));
			expect(toolLine).toBeGreaterThanOrEqual(0);
			expect(rawLine).toBeGreaterThan(toolLine);
			// The old text told the agent to "read that JSON" as the only route.
			expect(advisory).not.toContain("read that JSON");
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// Same class, second call site. The sweep test below is what keeps a third
	// one from being introduced; this pins the one that already existed.
	it("the code-quality advisory resolves too", () => {
		const cwd = makeProject("quality", false);
		try {
			const filePath = path.join(cwd, "src", "a.ts");
			const record = recordFromCodeQualityDiagnostic(
				{
					filePath,
					tool: "oxlint",
					rule: "complexity",
					message: "function is too complex",
					severity: "warning",
					semantic: "warning",
					line: 1,
					column: 1,
				} as never,
				cwd,
			);
			expect(record).toBeDefined();
			const report = buildCodeQualityWarningsReport({
				cwd,
				sessionId: "s-2521",
				turnIndex: 1,
				warnings: [record as never],
				modifiedRangesByFile: new Map(),
			});
			writeCodeQualityWarningsReport(new CacheManager(false), cwd, report);
			const advisory = formatCodeQualityWarningsAdvisory(report, cwd) as string;
			const advised = advisedRawPath(advisory);
			expect(advised).not.toBe(".pi-lens/cache/code-quality-warnings.json");
			const followed = followAdvisedPath(cwd, advised);
			expectSamePath(
				followed,
				path.join(
					getProjectDataDir(cwd),
					"cache",
					"code-quality-warnings.json",
				),
			);
			expect(fs.existsSync(followed)).toBe(true);
			expect(advisory).toContain("lens_diagnostics with mode=delta");
		} finally {
			removeTempDirSync(cwd);
		}
	});
});

describe("#2521 displayProjectDataPath", () => {
	const savedDataDir = process.env.PILENS_DATA_DIR;
	afterEach(() => {
		if (savedDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = savedDataDir;
	});

	// AGENTS.md's read-guard path-key invariant, applied to display: a Windows
	// caller can hand this either separator form and must get one answer.
	it("is separator-agnostic on its input (cross-form, #210 shape)", () => {
		const cwd = makeProject("crossform", true);
		try {
			// A backslash is a LEGAL POSIX filename character, so mechanically
			// swapping `/` for `\` only produces a genuine alternate-separator
			// form of `cwd` on win32. On POSIX it turns `cwd` into an unrelated,
			// nonexistent single-segment relative name, which makes
			// `getProjectDataDir` fall through to the global arm -- a false
			// finding, not the #210 shape this test targets (AGENTS.md: tests
			// must be OS-agnostic, but a Windows-only divergence gets a guarded
			// or platform-appropriate variant, never a silently vacuous one).
			if (process.platform === "win32") {
				const backslashed = cwd.replace(/\//g, "\\");
				const forwardSlashed = cwd.replace(/\\/g, "/");
				const a = displayProjectDataPath(
					backslashed,
					"cache",
					"actionable-warnings.json",
				);
				const b = displayProjectDataPath(
					forwardSlashed,
					"cache",
					"actionable-warnings.json",
				);
				expect(a).toBe(b);
				expect(a).toBe(".pi-lens/cache/actionable-warnings.json");
			}
			// Display and write must agree on any platform, native separator
			// form: `displayProjectDataPath` composes through
			// `getProjectDataDir`, so the two can never name different files.
			const shown = displayProjectDataPath(
				cwd,
				"cache",
				"actionable-warnings.json",
			);
			expect(shown).toBe(".pi-lens/cache/actionable-warnings.json");
			expect(path.resolve(cwd, shown)).toBe(
				path.join(getProjectDataDir(cwd), "cache", "actionable-warnings.json"),
			);
			// Never a backslash in agent-facing output, on any platform.
			expect(shown).not.toContain("\\");
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// Pure string work — this test deliberately points PILENS_DATA_DIR at a
	// path under the REAL home and never writes through it, because the `~`
	// fold is measured against `os.homedir()` while vitest pins PI_LENS_HOME
	// to a temp dir. `displayProjectDataPath` never stats or creates anything.
	it("folds a store under $HOME to ~ so the account name never reaches agent context", () => {
		const cwd = makeProject("homefold", false);
		try {
			process.env.PILENS_DATA_DIR = path.join(
				os.homedir(),
				".pi-lens",
				"projects",
			);
			const shown = displayProjectDataPath(
				cwd,
				"cache",
				"actionable-warnings.json",
			);
			expect(shown.startsWith("~/.pi-lens/projects/")).toBe(true);
			expect(shown.endsWith("/cache/actionable-warnings.json")).toBe(true);
			expect(shown).not.toContain("\\");
			expect(shown).not.toContain(os.homedir());
		} finally {
			removeTempDirSync(cwd);
		}
	});

	it("renders an out-of-home store absolutely rather than pretending it is relative", () => {
		const cwd = makeProject("outside", false);
		const dataDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2521-outside-")),
		);
		try {
			process.env.PILENS_DATA_DIR = dataDir;
			const shown = displayProjectDataPath(cwd, "cache", "x.json");
			expect(path.isAbsolute(shown) || shown.startsWith("~/")).toBe(true);
			expect(shown.startsWith("../")).toBe(false);
			expect(shown.endsWith("/cache/x.json")).toBe(true);
			// Pins the posix-ify-before-fold order (clients/file-utils.ts): the
			// absolute path is forward-slashed BEFORE homeRelativePath runs, so an
			// out-of-home store never renders with backslashes on any platform.
			expect(shown).not.toContain("\\");
		} finally {
			removeTempDirSync(cwd);
			removeTempDirSync(dataDir);
		}
	});
});
