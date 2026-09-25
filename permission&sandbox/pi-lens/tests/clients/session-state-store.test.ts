/**
 * Tests for #190 Phase 1 — per-session diagnostic state persistence + the
 * widget-state export/import that backs resume rehydration.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	dropStaleFiles,
	loadSessionState,
	saveSessionState,
	sessionStartMode,
	STATE_VERSION,
} from "../../clients/session-state-store.js";
import { createReadGuard } from "../../clients/read-guard.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnosticSummaries,
	importWidgetState,
	type PersistedWidgetState,
	recordDiagnostics,
	reconcileStaleWidgetFiles,
} from "../../clients/widget-state.js";

let dataDir: string;
let prevDataDir: string | undefined;
const cwd = "/proj/example";

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pi-lens-session-store-"));
	prevDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = dataDir;
});

afterAll(() => {
	if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = prevDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => clearWidgetState());

function seedDiagnostics() {
	recordDiagnostics("/proj/example/a.ts", [
		{
			tool: "tsc",
			severity: "error",
			semantic: "blocking",
			message: "boom",
			line: 5,
		},
	]);
	recordDiagnostics("/proj/example/b.ts", [
		{
			tool: "eslint",
			severity: "warning",
			message: "meh",
			line: 2,
			rule: "no-x",
		},
	]);
}

describe("widget-state export/import (#190)", () => {
	it("round-trips the per-file diagnostic state", () => {
		seedDiagnostics();
		const before = getFileDiagnosticSummaries();
		expect(before).toHaveLength(2);

		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(getFileDiagnosticSummaries()).toEqual([]);

		expect(importWidgetState(snapshot)).toBe(true);
		expect(getFileDiagnosticSummaries()).toEqual(before);
	});

	it("rejects a snapshot from a different version (no partial import)", () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(importWidgetState({ ...snapshot, version: 999 })).toBe(false);
		expect(getFileDiagnosticSummaries()).toEqual([]);
	});

	it("does NOT persist lspServers (process-bound) — only files + languages", () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		expect(Object.keys(snapshot)).toEqual(
			expect.arrayContaining(["version", "sessionLanguages", "files"]),
		);
		expect(
			(snapshot as unknown as Record<string, unknown>).lspServers,
		).toBeUndefined();
	});
});

describe("session-state-store save/load (#190)", () => {
	it("persists and reloads a session's widget snapshot keyed by session id", async () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		await saveSessionState(cwd, "019ead34-uuid", snapshot);

		const loaded = await loadSessionState(cwd, "019ead34-uuid");
		expect(loaded?.sessionId).toBe("019ead34-uuid");
		expect(loaded?.widget).toEqual(snapshot);
	});

	it("returns undefined for an unknown or empty session id", async () => {
		expect(await loadSessionState(cwd, "never-saved")).toBeUndefined();
		expect(await loadSessionState(cwd, "")).toBeUndefined();
		expect(await loadSessionState(cwd, undefined)).toBeUndefined();
	});

	it("save is a no-op for a missing session id (no throw)", async () => {
		await expect(
			saveSessionState(cwd, undefined, exportWidgetState()),
		).resolves.toBeUndefined();
		await expect(
			saveSessionState(cwd, "", exportWidgetState()),
		).resolves.toBeUndefined();
	});

	it("end-to-end resume flow: save → clear → load → import restores findings", async () => {
		seedDiagnostics();
		const before = getFileDiagnosticSummaries();
		await saveSessionState(cwd, "resume-me", exportWidgetState());

		// Simulate a fresh process: nothing in memory.
		clearWidgetState();
		expect(getFileDiagnosticSummaries()).toEqual([]);

		// Resume: load by the same stable id and rehydrate.
		const loaded = await loadSessionState(cwd, "resume-me");
		expect(importWidgetState(loaded?.widget)).toBe(true);
		expect(getFileDiagnosticSummaries()).toEqual(before);
	});

	it("fork hand-off: source snapshot branches into a new session id", async () => {
		// Mirrors the session_before_fork → session_start(fork) flow: stash the
		// source's in-memory snapshot, then adopt it under the forked session id.
		seedDiagnostics();
		const before = getFileDiagnosticSummaries();
		const stashed = exportWidgetState(); // captured at session_before_fork

		clearWidgetState(); // forked session starts empty in memory
		importWidgetState(stashed); // branch from source
		await saveSessionState(cwd, "forked-session", exportWidgetState());

		const loaded = await loadSessionState(cwd, "forked-session");
		expect(importWidgetState(loaded?.widget)).toBe(true);
		expect(getFileDiagnosticSummaries()).toEqual(before);
	});

	it("rejects and ignores a persisted snapshot whose version does not match STATE_VERSION (#1106)", async () => {
		seedDiagnostics();
		await saveSessionState(cwd, "wrong-version-session", exportWidgetState());

		// Sanity: the freshly-saved snapshot loads fine at the current version.
		const before = await loadSessionState(cwd, "wrong-version-session");
		expect(before?.version).toBe(STATE_VERSION);

		// Corrupt the on-disk version to a deliberate mismatch (never a hardcoded
		// literal — #1116 pattern) and confirm the reject path is taken: the
		// caller sees `undefined`, exactly like a missing/corrupt file.
		const sessionsDir = join(getProjectDataDir(cwd), "sessions");
		const [file] = readdirSync(sessionsDir).filter((f) =>
			f.includes("wrong-version-session"),
		);
		const filePath = join(sessionsDir, file);
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		raw.version = STATE_VERSION + 1;
		writeFileSync(filePath, JSON.stringify(raw));

		const loaded = await loadSessionState(cwd, "wrong-version-session");
		expect(loaded).toBeUndefined();
	});

	it("isolates sessions: one id's state does not leak into another", async () => {
		seedDiagnostics();
		await saveSessionState(cwd, "session-A", exportWidgetState());

		clearWidgetState();
		recordDiagnostics("/proj/example/c.ts", [
			{ tool: "ruff", severity: "error", message: "other", line: 1 },
		]);
		await saveSessionState(cwd, "session-B", exportWidgetState());

		const a = await loadSessionState(cwd, "session-A");
		const b = await loadSessionState(cwd, "session-B");
		expect(a?.widget.files.map((f) => f.filePath).sort()).toEqual([
			"/proj/example/a.ts",
			"/proj/example/b.ts",
		]);
		expect(b?.widget.files.map((f) => f.filePath)).toEqual([
			"/proj/example/c.ts",
		]);
	});
});

describe("sessionStartMode — reason → action mapping (#190)", () => {
	it("rehydrates on startup, not just resume (the pi --session launch case)", () => {
		// The original Phase 1 bug: a `pi --session <id>` LAUNCH fires
		// reason="startup", not "resume", so gating on "resume" missed it.
		expect(sessionStartMode("startup", false)).toBe("maybe-rehydrate");
		expect(sessionStartMode("resume", false)).toBe("maybe-rehydrate");
		expect(sessionStartMode(undefined, false)).toBe("maybe-rehydrate");
	});

	it("keeps state on reload, cleans on new", () => {
		expect(sessionStartMode("reload", false)).toBe("keep");
		expect(sessionStartMode("new", false)).toBe("clean");
	});

	it("forks only when a stash is pending, else falls through to rehydrate", () => {
		expect(sessionStartMode("fork", true)).toBe("fork");
		expect(sessionStartMode("fork", false)).toBe("maybe-rehydrate");
	});
});

describe("dropStaleFiles — freshness reconciliation (#190/#180)", () => {
	let fsDir: string;
	const fileEntry = (
		filePath: string,
	): PersistedWidgetState["files"][number] => ({
		filePath,
		runners: [],
		formatters: [],
		diagnostics: [],
		allDiagnostics: [],
		diagnosticCounts: { blocking: 0, errors: 0, warnings: 0 },
		hasFinalDiagnosticsSnapshot: true,
		touchedAt: 0,
	});

	beforeAll(() => {
		fsDir = mkdtempSync(join(tmpdir(), "pi-lens-stale-"));
	});
	afterAll(() => rmSync(fsDir, { recursive: true, force: true }));

	it("keeps unchanged files, drops files modified or deleted since the snapshot", async () => {
		const fresh = join(fsDir, "fresh.ts");
		const modified = join(fsDir, "modified.ts");
		const gone = join(fsDir, "gone.ts"); // never created on disk
		writeFileSync(fresh, "a");
		writeFileSync(modified, "b");

		const savedAt = Date.now();
		// fresh: last modified well before the snapshot → unchanged → keep
		utimesSync(fresh, new Date(savedAt - 60_000), new Date(savedAt - 60_000));
		// modified: touched after the snapshot → stale → drop
		utimesSync(
			modified,
			new Date(savedAt + 60_000),
			new Date(savedAt + 60_000),
		);

		const widget: PersistedWidgetState = {
			version: 1,
			sessionLanguages: [],
			files: [fileEntry(fresh), fileEntry(modified), fileEntry(gone)],
		};

		const result = await dropStaleFiles(widget, savedAt);
		expect(result.files.map((f) => f.filePath)).toEqual([fresh]);
	});

	it("preserves non-file fields and returns all files when none are stale", async () => {
		const a = join(fsDir, "a.ts");
		writeFileSync(a, "x");
		const savedAt = Date.now() + 60_000; // snapshot "after" the file mtime
		const widget: PersistedWidgetState = {
			version: 1,
			sessionLanguages: ["typescript"],
			files: [fileEntry(a)],
		};
		const result = await dropStaleFiles(widget, savedAt);
		expect(result.sessionLanguages).toEqual(["typescript"]);
		expect(result.files).toHaveLength(1);
	});
});

describe("reconcileStaleWidgetFiles — live widget freshness (lens_diagnostics)", () => {
	let liveDir: string;
	beforeAll(() => {
		liveDir = mkdtempSync(join(tmpdir(), "pi-lens-live-stale-"));
	});
	afterAll(() => rmSync(liveDir, { recursive: true, force: true }));
	beforeEach(() => clearWidgetState());

	it("drops files edited after their diagnostics were recorded, keeps unchanged ones", async () => {
		const fixed = join(liveDir, "fixed.ts");
		const unchanged = join(liveDir, "unchanged.ts");
		writeFileSync(fixed, "before");
		writeFileSync(unchanged, "stable");

		recordDiagnostics(fixed, [
			{ tool: "tsc", severity: "error", message: "boom", line: 1 },
		]);
		recordDiagnostics(unchanged, [
			{ tool: "eslint", severity: "warning", message: "meh", line: 1 },
		]);
		expect(getFileDiagnosticSummaries()).toHaveLength(2);

		// Simulate the agent fixing `fixed` AFTER it was last recorded: its mtime
		// now postdates touchedAt. `unchanged` keeps an older mtime.
		const recordedAt = Date.now();
		utimesSync(
			unchanged,
			new Date(recordedAt - 60_000),
			new Date(recordedAt - 60_000),
		);
		utimesSync(
			fixed,
			new Date(recordedAt + 60_000),
			new Date(recordedAt + 60_000),
		);

		const dropped = await reconcileStaleWidgetFiles();
		expect(dropped).toBe(1);
		expect(getFileDiagnosticSummaries().map((s) => s.filePath)).toEqual([
			unchanged,
		]);
	});

	it("drops entries whose file was deleted", async () => {
		const gone = join(liveDir, "gone.ts");
		writeFileSync(gone, "x");
		recordDiagnostics(gone, [
			{ tool: "tsc", severity: "error", message: "x", line: 1 },
		]);
		rmSync(gone, { force: true });

		expect(await reconcileStaleWidgetFiles()).toBe(1);
		expect(getFileDiagnosticSummaries()).toEqual([]);
	});
});

describe("read-guard read-set persistence across resume (#1041)", () => {
	it("save → load → import rehydrates the read-set so a resumed edit is allowed", async () => {
		// Real file on disk so recordRead captures line hashes and importState can
		// reconcile them against current content.
		const fileDir = mkdtempSync(join(tmpdir(), "pi-lens-rg-resume-"));
		const filePath = join(fileDir, "foo.ts");
		writeFileSync(
			filePath,
			`${Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n")}\n`,
		);
		// Backdate mtime so the file reads as authored in a prior session (the
		// resume scenario) rather than "written this session" — otherwise the edit
		// is session-authored-allowed and the zero-read baseline assertion is moot.
		const longAgo = new Date("2000-01-01T00:00:00Z");
		utimesSync(filePath, longAgo, longAgo);
		try {
			// Session 1: record a read, then persist on the SAME #190 snapshot the
			// widget state rides.
			const guard1 = createReadGuard("resume-session");
			guard1.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 50,
				effectiveOffset: 1,
				effectiveLimit: 50,
				expandedByLsp: false,
				turnIndex: 1,
				writeIndex: 1,
				timestamp: Date.now(),
			});
			await saveSessionState(
				cwd,
				"resume-session",
				exportWidgetState(),
				guard1.exportState(),
			);

			// Resume (maybe-rehydrate): fresh guard, load persisted state, import.
			const loaded = await loadSessionState(cwd, "resume-session");
			expect(loaded?.readGuard).toBeDefined();
			const guard2 = createReadGuard("resume-session-2");
			expect(guard2.checkEdit(filePath, [20, 30]).action).toBe("block");
			const result = guard2.importState(loaded?.readGuard);
			expect(result.imported).toBe(1);
			expect(guard2.getReadHistory(filePath)).toHaveLength(1);
			expect(guard2.checkEdit(filePath, [20, 30]).action).toBe("allow");
		} finally {
			rmSync(fileDir, { recursive: true, force: true });
		}
	});

	it("backward-compat: a payload persisted with NO readGuard field loads clean", async () => {
		seedDiagnostics();
		// Old-style save (pre-#1041) omits the readGuard arg entirely.
		await saveSessionState(cwd, "legacy-session", exportWidgetState());

		const loaded = await loadSessionState(cwd, "legacy-session");
		expect(loaded?.widget).toBeDefined();
		expect(loaded?.readGuard).toBeUndefined();

		// Importing the absent field is a null-safe no-op — no throw.
		const guard = createReadGuard("legacy-session");
		expect(() => guard.importState(loaded?.readGuard)).not.toThrow();
		expect(guard.importState(loaded?.readGuard)).toEqual({
			imported: 0,
			dropped: 0,
		});
	});
});
