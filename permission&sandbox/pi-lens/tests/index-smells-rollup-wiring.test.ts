import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiMock } from "./support/pi-mock.js";

// Wiring guard for the #1123 item 3 smells self-surfacing turn_end note:
// turn_end MUST call the bounded rollup (`countRecentSmells`) every
// SMELLS_TURN_CHECK_INTERVAL turns and surface a ctx.ui.notify the first time
// a smell crosses its threshold — never before the interval, never twice for
// the same smell in one session. This lives at the index.ts wiring seam (not
// clients/smells-rollup.ts's own unit tests) because the fact under test is
// "turn_end actually calls shouldCheckSmellsThisTurn/checkSmellsAndNoteOnce
// together and notifies" — only observable by driving the real turn handlers.
//
// Only `countRecentSmells` (the I/O boundary) is mocked; `checkSmellsAndNoteOnce`
// and `shouldCheckSmellsThisTurn` run for real so the once-per-session gate is
// exercised end-to-end, not re-asserted by a mock.

let mockedCounts = { staleCtxEmitFailed: 0, opengrepRespawn: 0 };
const countRecentSmells = vi.fn(
	(_root?: string, _sessionStartMs?: number) => mockedCounts,
);
vi.mock("../clients/smells-rollup.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/smells-rollup.js")>();
	return {
		...actual,
		countRecentSmells,
	};
});

// Heavy turn_end tail is separately tested; stub to keep this a wiring check.
vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		knipClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		deadCodeClients: [],
	}));
});
vi.mock("../clients/runtime-turn.js", () => ({
	handleTurnEnd: vi.fn(async () => undefined),
	cancelLSPIdleReset: vi.fn(),
}));

const notify = vi.fn();
const turnCtx = {
	cwd: process.cwd(),
	ui: {
		notify,
		setStatus: () => {},
		theme: { fg: (_c: string, s: string) => s },
	},
};

async function driveTurns(count: number) {
	const { default: registerExtension } = await import("../index.js");
	const mock = createPiMock({ "lens-lsp": true });
	registerExtension(mock.asExtensionAPI() as never);
	const turnStart = mock.getHandlers("turn_start")[0];
	const turnEnd = mock.getHandlers("turn_end")[0];
	expect(turnStart).toBeTypeOf("function");
	expect(turnEnd).toBeTypeOf("function");
	for (let i = 0; i < count; i++) {
		await turnStart?.({}, turnCtx as never);
		await turnEnd?.({}, turnCtx as never);
	}
	return mock;
}

function smellNotifyCalls() {
	return notify.mock.calls.filter(([msg]) =>
		String(msg).startsWith("pi-lens smell:"),
	);
}

// #1778: each case drives `driveTurns`, which pays a COLD
// `import("../index.js")` after `vi.resetModules()` in `beforeEach` —
// deliberate, not accidental. index.ts carries turn-scoped module state
// (the smells-rollup once-per-session gate, reset via
// resetSmellsSessionState), which is exactly what this wiring guard checks.
// Sharing one import across cases would defeat the isolation the tests exist
// to prove, so the fix is a timeout budget, not a hoisted import (matching
// #1772/#1779's index-loop-block-wiring fix and this repo's
// HEAVY_IO_TIMEOUT_MS convention,
// tests/clients/ast-grep-rule-precedence-followups.test.ts:210). Reproduced
// red pre-fix at 5222ms (over the 5000ms default) — see #1778.
const SMELLS_ROLLUP_WIRING_TIMEOUT_MS = 30_000;

describe(
	"index turn_end smells-rollup wiring (#1123 item 3)",
	{
		timeout: SMELLS_ROLLUP_WIRING_TIMEOUT_MS,
	},
	() => {
		beforeEach(async () => {
			vi.resetModules();
			notify.mockClear();
			countRecentSmells.mockClear();
			mockedCounts = { staleCtxEmitFailed: 0, opengrepRespawn: 0 };
			const { resetSmellsSessionState } =
				await import("../clients/smells-rollup.js");
			resetSmellsSessionState();
		});
		afterEach(() => {
			vi.clearAllMocks();
		});

		it("checks nothing before the interval (turn 19)", async () => {
			mockedCounts = { staleCtxEmitFailed: 99, opengrepRespawn: 99 };
			await driveTurns(19);
			expect(smellNotifyCalls()).toHaveLength(0);
		});

		it("notifies once when a smell is at/above threshold on the check turn (20)", async () => {
			mockedCounts = { staleCtxEmitFailed: 5, opengrepRespawn: 0 };
			await driveTurns(20);
			const calls = smellNotifyCalls();
			expect(calls).toHaveLength(1);
			expect(String(calls[0][0])).toContain("stale-ctx emit_failed");
			expect(calls[0][1]).toBe("warning");
		});

		it("passes the in-process session start, not the 24h fallback (S3c, #1432 review)", async () => {
			mockedCounts = { staleCtxEmitFailed: 5, opengrepRespawn: 0 };
			const before = Date.now();
			await driveTurns(20);
			const after = Date.now();
			expect(countRecentSmells).toHaveBeenCalled();
			const [rootArg, sessionStartArg] = countRecentSmells.mock.calls.at(-1)!;
			expect(rootArg).toBeUndefined();
			expect(sessionStartArg).toBeTypeOf("number");
			// The session (and thus its recorded start) is created inside
			// driveTurns, so it falls within [before, after] — nowhere near a
			// 24h-ago fallback value.
			expect(sessionStartArg as number).toBeGreaterThanOrEqual(before);
			expect(sessionStartArg as number).toBeLessThanOrEqual(after);
		});

		it("does not notify again on turn 40 for a smell already notified this session", async () => {
			mockedCounts = { staleCtxEmitFailed: 5, opengrepRespawn: 0 };
			await driveTurns(40);
			expect(smellNotifyCalls()).toHaveLength(1);
		});

		it("does not notify when every count stays below threshold", async () => {
			mockedCounts = { staleCtxEmitFailed: 1, opengrepRespawn: 1 };
			await driveTurns(20);
			expect(smellNotifyCalls()).toHaveLength(0);
		});
	},
);
