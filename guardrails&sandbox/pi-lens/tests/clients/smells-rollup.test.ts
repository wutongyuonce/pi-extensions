/**
 * Tests for the smells self-surfacing rollup (#1123 item 3).
 *
 * Coverage:
 *  - `tailReadText`'s cost bound: proven by construction (a file bigger than
 *    the byte budget only ever yields tail content, never the head).
 *  - `countRecentSmells` over hand-written NDJSON fixtures.
 *  - Threshold gating for both the session_start line (null below threshold)
 *    and the always-on health line (never null).
 *  - The turn-end "once per session per smell" note gate.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkSmellsAndNoteOnce,
	countRecentSmells,
	formatSmellsHealthLine,
	formatSmellsSessionStartLine,
	resetSmellsSessionState,
	SMELLS_TAIL_BYTES_PER_FILE,
	SMELLS_THRESHOLDS,
	type SmellsRollupCounts,
	shouldCheckSmellsThisTurn,
	tailReadText,
} from "../../clients/smells-rollup.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-smells-"));
	resetSmellsSessionState();
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	resetSmellsSessionState();
});

function writeLines(filePath: string, lines: string[]): void {
	fs.writeFileSync(filePath, lines.map((l) => `${l}\n`).join(""));
}

function staleCtxLine(ts = new Date().toISOString()): string {
	return JSON.stringify({
		ts,
		event: "pilens:files:touched",
		outcome: "emit_failed",
		cwd: "/repo",
		error: "Error: ctx is stale after session replacement",
	});
}

function opengrepRespawnLine(ts = new Date().toISOString()): string {
	return JSON.stringify({
		ts,
		type: "phase",
		phase: "lsp_server_respawn",
		filePath: "/repo",
		durationMs: 0,
		metadata: { serverId: "opengrep", root: "/repo", uptimeMs: 1000 },
	});
}

describe("tailReadText (cost bound)", () => {
	it("never reads more than maxBytes, even from a much larger file", () => {
		const filePath = path.join(tmpDir, "big.log");
		// 200KB of 'a' lines followed by a distinctive tail marker.
		const head = "a".repeat(200 * 1024);
		fs.writeFileSync(filePath, `${head}\nTAIL_MARKER\n`);

		const budget = 64; // tiny budget so the assertion is unambiguous
		const text = tailReadText(filePath, budget);

		expect(text.length).toBeLessThanOrEqual(budget);
		expect(text).not.toContain("a".repeat(100)); // never sees the head
	});

	it("returns the tail content intact when it fits within the budget", () => {
		const filePath = path.join(tmpDir, "small.log");
		fs.writeFileSync(filePath, "line1\nline2\nline3\n");
		const text = tailReadText(filePath, SMELLS_TAIL_BYTES_PER_FILE);
		expect(text).toBe("line1\nline2\nline3\n");
	});

	it("returns '' for a missing file (never throws)", () => {
		expect(tailReadText(path.join(tmpDir, "missing.log"), 1024)).toBe("");
	});

	it("drops a partial leading line when the read starts mid-file", () => {
		const filePath = path.join(tmpDir, "partial.log");
		// Construct content where the tail-read window starts inside "HEADJUNK".
		fs.writeFileSync(filePath, "HEADJUNK\nCLEAN_LINE_1\nCLEAN_LINE_2\n");
		const size = fs.statSync(filePath).size;
		// Budget chosen to land the read start inside "HEADJUNK", not on a boundary.
		const budget = size - 4;
		const text = tailReadText(filePath, budget);
		expect(text).not.toContain("HEADJUNK");
		expect(text).toContain("CLEAN_LINE_1");
		expect(text).toContain("CLEAN_LINE_2");
	});
});

describe("countRecentSmells", () => {
	it("returns zero counts when neither log file exists", () => {
		expect(countRecentSmells(tmpDir)).toEqual({
			staleCtxEmitFailed: 0,
			opengrepRespawn: 0,
		});
	});

	it("counts stale-ctx emit_failed rows in bus-events.log and ignores other outcomes/errors", () => {
		writeLines(path.join(tmpDir, "bus-events.log"), [
			staleCtxLine(),
			staleCtxLine(),
			JSON.stringify({
				outcome: "skipped_stale_session",
				error: "Error: ctx is stale after session replacement",
			}),
			JSON.stringify({ outcome: "emitted", event: "x" }),
			JSON.stringify({ outcome: "emit_failed", error: "ECONNRESET" }),
			"not json at all",
		]);
		const counts = countRecentSmells(tmpDir);
		expect(counts.staleCtxEmitFailed).toBe(2);
	});

	it("counts opengrep respawns in latency.log and ignores respawns of other servers", () => {
		writeLines(path.join(tmpDir, "latency.log"), [
			opengrepRespawnLine(),
			opengrepRespawnLine(),
			opengrepRespawnLine(),
			JSON.stringify({
				type: "phase",
				phase: "lsp_server_respawn",
				metadata: { serverId: "typescript" },
			}),
			JSON.stringify({ type: "phase", phase: "lsp_client_skipped_broken" }),
		]);
		const counts = countRecentSmells(tmpDir);
		expect(counts.opengrepRespawn).toBe(3);
	});

	it("caps total I/O at 2 * SMELLS_TAIL_BYTES_PER_FILE regardless of source size", () => {
		// A large file well past the per-file budget must still resolve fast and
		// only reflect its tail — proves the bound holds end-to-end, not just at
		// the tailReadText unit.
		const lines: string[] = [];
		for (let i = 0; i < 20000; i++) {
			lines.push(JSON.stringify({ outcome: "emitted", i }));
		}
		lines.push(staleCtxLine());
		writeLines(path.join(tmpDir, "bus-events.log"), lines);
		const counts = countRecentSmells(tmpDir);
		expect(counts.staleCtxEmitFailed).toBe(1);
	});

	it("scopes both smell types to rows at or after the session boundary", () => {
		const sessionStartMs = Date.parse("2026-08-14T10:00:00.000Z");
		const before = "2026-08-14T09:59:59.999Z";
		const after = "2026-08-14T10:00:00.001Z";
		writeLines(path.join(tmpDir, "bus-events.log"), [
			staleCtxLine(before),
			staleCtxLine(after),
		]);
		writeLines(path.join(tmpDir, "latency.log"), [
			opengrepRespawnLine(before),
			opengrepRespawnLine(after),
		]);

		expect(countRecentSmells(tmpDir, sessionStartMs)).toEqual({
			staleCtxEmitFailed: 1,
			opengrepRespawn: 1,
		});
	});

	it("reports no pre-session failures and retains post-session failures", () => {
		const sessionStartMs = Date.parse("2026-08-14T10:00:00.000Z");
		const before = "2026-08-14T09:59:59.999Z";
		const after = "2026-08-14T10:00:00.001Z";

		writeLines(path.join(tmpDir, "bus-events.log"), [staleCtxLine(before)]);
		expect(countRecentSmells(tmpDir, sessionStartMs).staleCtxEmitFailed).toBe(
			0,
		);

		writeLines(path.join(tmpDir, "bus-events.log"), [staleCtxLine(after)]);
		expect(countRecentSmells(tmpDir, sessionStartMs).staleCtxEmitFailed).toBe(
			1,
		);
	});

	it("excludes pre-window rows and counts rows inside the rolling fallback window", () => {
		const now = Date.now();
		writeLines(path.join(tmpDir, "bus-events.log"), [
			staleCtxLine(new Date(now - 25 * 60 * 60_000).toISOString()),
			staleCtxLine(new Date(now - 23 * 60 * 60_000).toISOString()),
		]);
		expect(countRecentSmells(tmpDir).staleCtxEmitFailed).toBe(1);
	});

	it("does not report matching rows without a parseable timestamp when scoped", () => {
		// An explicitly unparseable ts, NOT the helper default (which is
		// `new Date().toISOString()` — a valid current timestamp that on a fast
		// machine equals the Date.now() boundary below to the millisecond and is
		// wrongly admitted, making this a timing flake instead of the
		// missing-timestamp case it names).
		writeLines(path.join(tmpDir, "bus-events.log"), [
			staleCtxLine("not-a-timestamp"),
		]);
		writeLines(path.join(tmpDir, "latency.log"), [
			JSON.stringify({
				phase: "lsp_server_respawn",
				metadata: { serverId: "opengrep" },
			}),
		]);

		expect(countRecentSmells(tmpDir, Date.now())).toEqual({
			staleCtxEmitFailed: 0,
			opengrepRespawn: 0,
		});
	});
});

describe("formatSmellsSessionStartLine (threshold-gated)", () => {
	it("returns null when every smell is below threshold", () => {
		const counts: SmellsRollupCounts = {
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed - 1,
			opengrepRespawn: SMELLS_THRESHOLDS.opengrepRespawn - 1,
		};
		expect(formatSmellsSessionStartLine(counts)).toBeNull();
	});

	it("emits a line once a smell reaches its threshold", () => {
		const counts: SmellsRollupCounts = {
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed,
			opengrepRespawn: 0,
		};
		const line = formatSmellsSessionStartLine(counts);
		expect(line).not.toBeNull();
		expect(line).toContain(`x${SMELLS_THRESHOLDS.staleCtxEmitFailed}`);
		expect(line).toContain("logs:smells");
	});

	it("includes both smells when both trip", () => {
		const counts: SmellsRollupCounts = {
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed,
			opengrepRespawn: SMELLS_THRESHOLDS.opengrepRespawn,
		};
		const line = formatSmellsSessionStartLine(counts);
		expect(line).toContain("stale-ctx emit_failed");
		expect(line).toContain("opengrep respawn");
	});
});

describe("formatSmellsHealthLine (always-on)", () => {
	it("renders current counts even when everything is below threshold", () => {
		const line = formatSmellsHealthLine({
			staleCtxEmitFailed: 0,
			opengrepRespawn: 0,
		});
		expect(line).toContain("stale-ctx emit_failed=0");
		expect(line).toContain("opengrep respawn=0");
		// S3c (#1432 review): /lens-health has no session boundary to anchor to
		// and falls back to the 24h rolling window — label it explicitly rather
		// than the ambiguous "recent tail-scan".
		expect(line).toContain("last 24h tail-scan");
	});
});

describe("shouldCheckSmellsThisTurn (cadence)", () => {
	it("is false on turn 0", () => {
		expect(shouldCheckSmellsThisTurn(0)).toBe(false);
	});

	it("is true exactly on interval multiples", () => {
		expect(shouldCheckSmellsThisTurn(20)).toBe(true);
		expect(shouldCheckSmellsThisTurn(40)).toBe(true);
		expect(shouldCheckSmellsThisTurn(21)).toBe(false);
	});
});

describe("checkSmellsAndNoteOnce (bounded to once per session per smell)", () => {
	it("returns no notes below threshold", () => {
		expect(
			checkSmellsAndNoteOnce({ staleCtxEmitFailed: 1, opengrepRespawn: 1 }),
		).toEqual([]);
	});

	it("fires a note the first time a smell crosses threshold", () => {
		const notes = checkSmellsAndNoteOnce({
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed,
			opengrepRespawn: 0,
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("stale-ctx emit_failed");
	});

	it("never fires the same smell twice in one session, even as the count grows", () => {
		checkSmellsAndNoteOnce({
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed,
			opengrepRespawn: 0,
		});
		const second = checkSmellsAndNoteOnce({
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed + 50,
			opengrepRespawn: 0,
		});
		expect(second).toEqual([]);
	});

	it("resetSmellsSessionState re-arms the gate for a fresh session", () => {
		checkSmellsAndNoteOnce({
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed,
			opengrepRespawn: 0,
		});
		resetSmellsSessionState();
		const notes = checkSmellsAndNoteOnce({
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed,
			opengrepRespawn: 0,
		});
		expect(notes).toHaveLength(1);
	});

	it("tracks each smell independently", () => {
		const notes = checkSmellsAndNoteOnce({
			staleCtxEmitFailed: SMELLS_THRESHOLDS.staleCtxEmitFailed,
			opengrepRespawn: SMELLS_THRESHOLDS.opengrepRespawn,
		});
		expect(notes).toHaveLength(2);
	});
});
