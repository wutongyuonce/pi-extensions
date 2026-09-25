/**
 * #2526: `npm run logs:smells` gains a "config resolution" smell.
 *
 * Two shapes, one smell id, asserted against the real script run as a
 * subprocess over a crafted log root — the same harness
 * `analyze-pi-lens-logs.test.ts` uses, kept in its own file so the shared
 * fixture's existing count assertions stay untouched:
 *
 * 1. A session that has a `config_resolution_pending` mark and produced no
 *    `config_resolved` row.
 * 2. A `config_resolved` row carrying a LEGACY document that produced zero
 *    migration records — the deprecation machinery gone silent while the user
 *    sits on a removal schedule.
 *
 * A canonical-only session with its row present must produce NO smell: silence
 * has to mean "resolved and clean", which is the whole point of the issue.
 *
 * ## Round 2, F2: a JOIN, not a subtraction
 *
 * The first round counted `Math.max(0, starts - resolved)`, subtracting
 * `config_resolved` rows from `session_start cwd:` lines. Those two facts do
 * not describe the same population. `session_start cwd:` is written on the FULL
 * path only (`runtime-session.ts` returns from quick mode well before it),
 * while a QUICK session resolves config and writes a row — so a quick
 * session's row cancelled a full session's missing one and total silence
 * summed to zero. The inverse was worse: a `--no-lsp` or subagent session
 * emits the start line and never resolves, so it contributed a PERMANENT false
 * deficit that a reader learns to ignore.
 *
 * ## Round 3, S1: no more prediction, no more `expected`/`reason`
 *
 * Round 2 fixed the JOIN but kept a PREDICTION on the session side:
 * `handleSessionStart` published `session_start config-resolution
 * session=<id> expected=<bool> reason=<...>`, with `expected` mirrored from
 * the same `no-lsp`/subagent/warm-attach flags the resolution paths gate on.
 * That mirror drifted: quick and minimal mode's SECOND session in a process
 * schedule no resolution at all (a process-lifetime memo short-circuits it),
 * so the prediction said `expected=true` for a session that could never
 * resolve, and the smell flagged a healthy session every time.
 *
 * `loadLSPConfig` now publishes its own `session_start config_resolution_pending
 * session=<id>` mark, as the FIRST thing it does, so the mark fires exactly
 * when a resolution is genuinely ATTEMPTED — never predicted. A session that
 * never reaches `loadLSPConfig` publishes no mark and is silently excluded,
 * not counted against. The smell now joins pending marks against rows,
 * exactly like round 2's row-vs-start-line join, but on real evidence instead
 * of a guess.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../scripts/analyze-pi-lens-logs.mjs",
);

const NOW = new Date().toISOString();
const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

interface Smell {
	id: string;
	count: number;
	severity: string;
	description: string;
	examples: unknown[];
}

interface Report {
	smells: Smell[];
	config: {
		resolved: number;
		sessionsPendingResolution: number;
		sessionsWithoutResolution: number;
		legacyDocuments: number;
		legacyWithoutRecords: number;
	};
}

/** The root every single-root fixture below implicitly shares. */
const DEFAULT_ROOT = "/home/u/Desktop/proj";

function configResolvedRow(options: {
	sessionId: string;
	documents: Array<{ tier: string; file: string; legacy: boolean }>;
	recordCount: number;
	root?: string;
}): Record<string, unknown> {
	return {
		type: "phase",
		ts: NOW,
		phase: "config_resolved",
		filePath: options.root ?? DEFAULT_ROOT,
		durationMs: 3,
		metadata: {
			sessionId: options.sessionId,
			documents: options.documents,
			countsByTier: { builtin: 0, global: 0, project: 4 },
			recordCount: options.recordCount,
			deniedServers: 0,
			resolveMs: 3,
		},
	};
}

/**
 * One session's sessionstart.log footprint. Byte-for-byte the same line shape
 * `publishConfigResolutionPending` writes (`clients/lsp/config.ts`) — a
 * fixture that diverges from the real line format proves nothing about the
 * real parser.
 */
interface SessionFixture {
	id: string;
	/** Whether this session's `loadLSPConfig` call ever happened at all. */
	pending: boolean;
	/**
	 * Round 4 (#2552 review): the served root the mark was published for. A
	 * warm MCP process keeps ONE session id for its life but serves many
	 * roots — defaults to `DEFAULT_ROOT` so every pre-existing single-root
	 * fixture keeps matching on both sides without naming a root explicitly.
	 */
	root?: string;
}

function sessionLines(session: SessionFixture): string[] {
	return session.pending
		? [
				`[${NOW}] session_start config_resolution_pending session=${session.id} root=${session.root ?? DEFAULT_ROOT}`,
			]
		: [];
}

function buildRoot(options: {
	sessions: SessionFixture[];
	latency: Array<Record<string, unknown>>;
}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfgsmell-"));
	roots.push(dir);
	fs.writeFileSync(
		path.join(dir, "latency.log"),
		`${options.latency.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	fs.writeFileSync(
		path.join(dir, "sessionstart.log"),
		`${options.sessions.flatMap(sessionLines).join("\n")}\n`,
	);
	return dir;
}

function runReport(root: string): Report {
	const out = execFileSync(
		process.execPath,
		[SCRIPT, "--root", root, "--json", "--since", "all"],
		{ encoding: "utf8" },
	);
	return JSON.parse(out) as Report;
}

function smell(report: Report): Smell | undefined {
	return report.smells.find((entry) => entry.id === "config-resolution");
}

const CANONICAL_DOCUMENT = {
	tier: "project",
	file: "~/Desktop/proj/.pi-lens.json",
	legacy: false,
};
const LEGACY_DOCUMENT = {
	tier: "project",
	file: "~/Desktop/proj/pi-lens.json",
	legacy: true,
};

describe("config-resolution smell (#2526)", () => {
	it("stays silent when every pending session has its row", () => {
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "s1", pending: true },
					{ id: "s2", pending: true },
				],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
					configResolvedRow({
						sessionId: "s2",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			resolved: 2,
			sessionsPendingResolution: 2,
			sessionsWithoutResolution: 0,
			legacyDocuments: 0,
			legacyWithoutRecords: 0,
		});
	});

	it("flags the pending sessions that produced no row", () => {
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "s1", pending: true },
					{ id: "s2", pending: true },
					{ id: "s3", pending: true },
				],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		const found = smell(report);
		expect(found, "expected a config-resolution smell").toBeDefined();
		expect(found?.count).toBe(2);
		expect(found?.description).toContain("no config_resolved row (2 of 3)");
		expect(report.config.sessionsWithoutResolution).toBe(2);
		// The example must name the session, so a reader can grep both logs for it.
		expect(JSON.stringify(found?.examples)).toContain("s2");
	});

	/**
	 * #2526 review round 3, S1 — the exact fixture the reviewer's probe names:
	 * a session that never reaches `loadLSPConfig` at all (quick/minimal mode's
	 * second-and-later session in a process) publishes no pending mark and
	 * must not be counted against — the false positive the deleted `expected`
	 * PREDICTION produced every time under `PI_LENS_STARTUP_MODE=quick` or
	 * `=minimal`.
	 */
	it("a session with no pending mark is never counted against (quick/minimal mode session 2)", () => {
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "s1", pending: true },
					// session 2: no `loadLSPConfig` call anywhere, so no pending line —
					// this is what `sessionLines({pending:false})` produces (nothing).
					{ id: "s2", pending: false },
				],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			resolved: 1,
			sessionsPendingResolution: 1,
			sessionsWithoutResolution: 0,
		});
	});

	/**
	 * #2526 review round 3, S1 — "full mode session with the load scheduled but
	 * no row": a resolution that was genuinely ATTEMPTED (the pending mark
	 * exists) but never finished (no row — e.g. it threw mid-flight, as
	 * `tests/clients/config-resolved-phase.test.ts`'s "a resolution that throws
	 * still leaves a pending mark with no row" proves at the `loadLSPConfig`
	 * level). The analyzer does not care WHICH startup mode scheduled the
	 * attempt — only that a mark exists with no matching row.
	 */
	it("a pending mark with no row at all is flagged (resolution attempted, never finished)", () => {
		const report = runReport(
			buildRoot({
				sessions: [{ id: "s1", pending: true }],
				latency: [],
			}),
		);
		const found = smell(report);
		expect(found, "a pending mark with zero rows must flag").toBeDefined();
		expect(found?.count).toBe(1);
		expect(report.config).toMatchObject({
			resolved: 0,
			sessionsPendingResolution: 1,
			sessionsWithoutResolution: 1,
		});
	});

	it("flags a legacy document that produced zero migration records", () => {
		const report = runReport(
			buildRoot({
				sessions: [{ id: "s1", pending: true }],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [LEGACY_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		const found = smell(report);
		expect(found?.count).toBe(1);
		expect(report.config).toMatchObject({
			resolved: 1,
			sessionsWithoutResolution: 0,
			legacyDocuments: 1,
			legacyWithoutRecords: 1,
		});
		// The example must name the offending document — a smell whose example
		// prints only a phase name costs the reader a second forensics pass.
		expect(JSON.stringify(found?.examples)).toContain(
			"project:~/Desktop/proj/pi-lens.json (legacy)",
		);
	});

	it("does not flag a legacy document that DID produce records", () => {
		const report = runReport(
			buildRoot({
				sessions: [{ id: "s1", pending: true }],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [LEGACY_DOCUMENT],
						recordCount: 2,
					}),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			legacyDocuments: 1,
			legacyWithoutRecords: 0,
		});
	});

	/**
	 * The `config resolved … session=<id>` line the loader writes to
	 * sessionstart.log satisfies the join on its own. The two sinks are written
	 * by ONE call at one instant, so this is not a second source of truth — it
	 * is the same fact surviving an independent rotation of latency.log.
	 */
	it("the sessionstart config-resolved line alone satisfies the join", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfgsmell-"));
		roots.push(dir);
		fs.writeFileSync(path.join(dir, "latency.log"), "");
		fs.writeFileSync(
			path.join(dir, "sessionstart.log"),
			`[${NOW}] session_start config_resolution_pending session=s1 root=${DEFAULT_ROOT}\n` +
				`[${NOW}] config resolved documents=1 legacy=0 records=0 deniedServers=0 resolveMs=2 session=s1 root=${DEFAULT_ROOT}\n`,
		);
		const report = runReport(dir);
		expect(smell(report)).toBeUndefined();
		expect(report.config.sessionsWithoutResolution).toBe(0);
	});

	/**
	 * #2552 review round 4 (reviewer's exact fixture). The warm MCP server
	 * keeps ONE session id for the life of the process but calls `ensureReady`
	 * — and therefore `loadLSPConfig` — once per SERVED ROOT (#2526 review
	 * round 2, F3's premise). Two roots under one session id must not collapse
	 * into one join entry: root A resolves, root B's resolution fails
	 * mid-flight (a pending mark with no row), and the smell must still catch
	 * root B even though the session id alone already has a row.
	 *
	 * Before this round, `pendingSessions` was `Map<sessionId, …>` and
	 * `resolvedSessions` was a flat `Set<sessionId>` — the second `.set()` for
	 * the same session id silently overwrote the first, and `resolvedSessions.
	 * has(id)` matched on session id alone, so root A's row falsely cleared
	 * root B's deficit. This is round 2 F3's defect reintroduced one layer up,
	 * at the analyzer join instead of the claim.
	 */
	it("two roots under one session id (warm MCP): root B's failed resolution is not hidden by root A's row", () => {
		const rootA = "/home/u/projA";
		const rootB = "/home/u/projB";
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "mcpproc1", pending: true, root: rootA },
					{ id: "mcpproc1", pending: true, root: rootB },
				],
				latency: [
					configResolvedRow({
						sessionId: "mcpproc1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
						root: rootA,
					}),
				],
			}),
		);
		const found = smell(report);
		expect(
			found,
			"root B's pending mark has no matching row and must flag, even though root A (same session id) resolved",
		).toBeDefined();
		expect(found?.count).toBe(1);
		expect(report.config).toMatchObject({
			resolved: 1,
			sessionsPendingResolution: 2,
			sessionsWithoutResolution: 1,
		});
	});

	it("two roots under one session id, both resolved: stays silent", () => {
		const rootA = "/home/u/projA";
		const rootB = "/home/u/projB";
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "mcpproc1", pending: true, root: rootA },
					{ id: "mcpproc1", pending: true, root: rootB },
				],
				latency: [
					configResolvedRow({
						sessionId: "mcpproc1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
						root: rootA,
					}),
					configResolvedRow({
						sessionId: "mcpproc1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
						root: rootB,
					}),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			resolved: 2,
			sessionsPendingResolution: 2,
			sessionsWithoutResolution: 0,
		});
	});
});
