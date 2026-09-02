/**
 * Turn-end integration for the past-EOF gate on the inline-blocker store
 * (#1641 remainder).
 *
 * #1664 wired the shared past-EOF gate (`demotePastEofDiagnostics`) into
 * widget-state, `lens_diagnostics`, and the TUI render loop, but deferred the
 * turn-end "Unresolved from this turn" inline-blocker store
 * (`RuntimeCoordinator._pendingInlineBlockers`) to #1633. #1633 merged
 * without it. This drives the real `handleTurnEnd` and asserts:
 *
 *   1. A blocker citing a line beyond the file's CURRENT line count is NOT
 *      re-served as an authoritative "Unresolved from this turn" blocker; it
 *      is demoted to a `[stale — re-run to confirm]` advisory.
 *   2. RE-ARMS, never latches: once the file grows back past the cited line
 *      (a transient shrink-then-restore), the SAME record is re-served at
 *      full authority again on the next turn end.
 *   3. Composes with #1631's dependency-drift gate rather than fighting it —
 *      a blocker already demoted for drift is left alone by this gate.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import { _resetSharedLineCountCacheForTests } from "../../clients/diagnostic-line-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

function readTurnEndContent(cacheManager: CacheManager, cwd: string): string {
	const findings = cacheManager.readCache<{ content: string }>(
		"turn-end-findings",
		cwd,
	);
	return findings?.data?.content ?? "";
}

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	_resetSharedLineCountCacheForTests();
});

describe("turn-end past-EOF gate for inline blockers (#1641)", () => {
	it("does not re-serve a blocker citing a line past current EOF as authoritative", async () => {
		const env = setupTestEnvironment("pi-lens-past-eof-turnend-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "past-eof-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			// A 2-line file — a blocker citing line 999 cannot describe it.
			const target = path.join(env.tmpDir, "shrunk.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			runtime.bumpFileSeq(target);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"past-eof-session",
			);
			runtime.recordInlineBlockers(
				target,
				"🔴 L999 something no longer at this coordinate",
				1,
				["lsp"],
				[999],
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).toContain(path.basename(target));
			expect(content).not.toContain("Unresolved from this turn");

			const sweepRecord = logLatency.mock.calls
				.map((call) => call[0])
				.find(
					(entry: any) =>
						entry?.type === "phase" &&
						entry?.phase === "blocker_past_eof_sweep",
				);
			expect(sweepRecord).toBeDefined();
			expect(sweepRecord.metadata).toMatchObject({
				total: 1,
				checked: 1,
				demoted: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("still re-serves an in-bounds blocker as an authoritative blocker", async () => {
		const env = setupTestEnvironment("pi-lens-past-eof-turnend-keep-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "keep-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const target = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\nexport const b = 2;\n");
			runtime.bumpFileSeq(target);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				"keep-session",
			);
			runtime.recordInlineBlockers(
				target,
				"🔴 L2 a real blocker",
				1,
				["lsp"],
				[2],
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("Unresolved from this turn");
			expect(content).not.toContain("[stale — re-run to confirm]");
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #1944 SUPERSEDES the cross-turn arm of #1641's re-arm property, and this
	 * test encodes the replacement contract.
	 *
	 * #1641 kept a past-EOF demotion in the store indefinitely so a
	 * shrink-then-restore could un-demote it. Live measurement (session
	 * 01a0234c) showed the cost of "indefinitely": the record re-served on
	 * every turn end for 80+ minutes, carrying full blocker authority in its
	 * body and citing lines the file no longer had. #1944 delivers such a
	 * record ONCE, degraded, then retires it.
	 *
	 * What that gives up, stated plainly: an out-of-band restore — the file
	 * grows back past the cited line WITHOUT going through pi-lens's write
	 * path — no longer resurrects the old verdict. A restore that DOES go
	 * through the write path re-dispatches the file and records a fresh
	 * verdict, which is better evidence than the retired one. The lost case is
	 * re-asserting a verdict at full authority over content nothing re-scanned.
	 *
	 * The gate itself still re-arms rather than latching: nothing marks the
	 * FILE as permanently suspect, so the next dispatch of it starts clean.
	 */
	it("retires a delivered past-EOF demotion instead of re-arming it (#1944)", async () => {
		const env = setupTestEnvironment("pi-lens-past-eof-turnend-rearm-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "rearm-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const target = path.join(env.tmpDir, "rearm.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			runtime.bumpFileSeq(target);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"rearm-session",
			);
			// Non-LSP source (#1631 F4 fail-closed provenance): keeps the
			// dependency-drift gate out of this record entirely, so rewriting the
			// file below to re-arm the PAST-EOF gate doesn't also trip the OTHER
			// gate's own (also correct, but not what this test isolates) drift
			// check on the file's own mtime moving.
			runtime.recordInlineBlockers(
				target,
				"🔴 L5 cited past current EOF",
				1,
				["eslint"],
				[5],
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);
			expect(readTurnEndContent(cacheManager, env.tmpDir)).toContain(
				"[stale — re-run to confirm]",
			);

			// #1944: the record was retired by the delivery above.
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);

			// The file grows back past the cited line, out of band. Re-touch the
			// turn-modified bookkeeping too: `handleTurnEnd` early-returns (and
			// leaves the previous cached findings untouched) when it sees no
			// modified files this turn, which a second `handleTurnEnd` call
			// otherwise trips into with a stale-looking result.
			_resetSharedLineCountCacheForTests();
			fs.writeFileSync(
				target,
				"export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n",
			);
			runtime.beginTurn();
			runtime.bumpFileSeq(target);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 5 },
				false,
				env.tmpDir,
				"rearm-session",
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);
			// No resurrection: the retired verdict does not come back at full
			// authority just because the coordinates exist again. Only a fresh
			// dispatch of the file can put a blocker back in the store.
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			const healedContent = readTurnEndContent(cacheManager, env.tmpDir);
			expect(healedContent).not.toContain("Unresolved from this turn");
		} finally {
			env.cleanup();
		}
	});

	it("does not fight a blocker already demoted by the dependency-drift gate", async () => {
		const env = setupTestEnvironment("pi-lens-past-eof-compose-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "compose-session" });
			runtime.beginTurn();

			const target = path.join(env.tmpDir, "composed.ts");
			fs.writeFileSync(target, "export const a = 1;\nexport const b = 2;\n");
			runtime.recordInlineBlockers(
				target,
				"🔴 L2 a real blocker",
				1,
				["lsp"],
				[2],
			);
			// Simulate the dependency-drift gate having already demoted this
			// entry this turn — the past-EOF gate must leave it alone.
			runtime.markInlineBlockerStale(target, "dependency-drift");

			const before = runtime.getInlineBlockersSnapshot()[0];
			expect(before.stale).toBe(true);
			expect(before.staleReason).toBe("dependency-drift");

			const { sweepInlineBlockerPastEof } =
				await import("../../clients/blocker-past-eof.js");
			const counts = sweepInlineBlockerPastEof(runtime, env.tmpDir);
			expect(counts.checked).toBe(0);

			const after = runtime.getInlineBlockersSnapshot()[0];
			expect(after.stale).toBe(true);
			expect(after.staleReason).toBe("dependency-drift");
		} finally {
			env.cleanup();
		}
	});
});
