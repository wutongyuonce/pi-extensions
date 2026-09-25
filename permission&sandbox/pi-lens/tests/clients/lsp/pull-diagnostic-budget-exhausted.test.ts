/**
 * #1773: a budget-exhausted pull previously dispatched anyway. The old clamp
 * (`Math.max(1, Math.min(PULL_REQUEST_TIMEOUT_MS, budgetMs))`) let
 * `budgetMs <= 0` through as an unwinnable 1ms pull — sent, timed out by
 * construction, and recorded as a genuine `lsp_pull_diagnostic_timeout` with
 * a fabricated `effectiveBudgetMs: 1`. Fix: below a 5ms usable floor
 * (`PULL_MIN_USABLE_BUDGET_MS`, `budgetMs < floor`, so the floor value ITSELF
 * still dispatches), skip the dispatch entirely and emit a distinct
 * `lsp_pull_skipped_budget_exhausted` record instead, counted in the ledger
 * under `lsp-pull-skipped-budget-exhausted` (review round: a repeatedly
 * budget-exhausted caller is worth seeing in aggregate too). TWO entry points
 * had this clamp independently — `pullDiagnosticSource` (the
 * `lens_diagnostics_full` fan-out) and `clientRequestWorkspaceDiagnostics`
 * (the `workspace/diagnostic` round) — both fixed and both covered below,
 * per live dogfood evidence naming both as sources of the artifact.
 *
 * #1774: a pull timeout arms a telemetry-only continuation on the abandoned
 * request (`armLateAnswerTelemetry`). It already saw late RESOLUTIONS
 * (`lsp_pull_late_answer_discarded`), but the rejection branch was silent, so
 * "timeout then silence" and "timeout then server rejection" read identically
 * in latency.log. Fix: the rejection path now emits a bounded
 * `lsp_pull_late_rejection` record (error code, server, elapsed-since-
 * timeout) while still swallowing the rejection — behavior on that path is
 * otherwise unchanged. Review round: the ledger subject is prefixed with the
 * server (matching the timeout kind's own `server::file` shape), because the
 * workspace call site's subject is the bare `WORKSPACE_PULL_SCOPE` constant —
 * without the prefix two servers' rejections would collapse into one.
 *
 * #1771: `lsp_pull_diagnostic_timeout` (a genuine, dispatched-then-abandoned
 * pull) was emitted with no `ledgerKind`, so it counted nothing in the
 * degradation ledger even though it is a failure path by the
 * bounded-telemetry module's own rule. Fix: `recordPullTimeoutTelemetry` now
 * passes `ledgerKind: "lsp-pull-diagnostic-timeout"`, subject preserving
 * server + file identity.
 *
 * Connection-double tests: `state.connection.sendRequest` is a mock, not a
 * wire-protocol server (matches `pull-diagnostic-timeout-telemetry.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { latencyEvents } = vi.hoisted(() => ({
	latencyEvents: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: vi.fn((event: Record<string, unknown>) => {
			latencyEvents.push(event);
		}),
	};
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	clientRequestWorkspaceDiagnostics,
	clientWaitForDiagnostics,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pullState(overrides?: Partial<LSPClientState>): LSPClientState {
	return createMockState({
		serverId: "typescript",
		root: "/project",
		workspaceDiagnosticsSupport: {
			advertised: true,
			mode: "pull",
			workspaceDiagnostics: false,
			diagnosticProviderKind: "static",
		},
		staticDiagnosticsMode: "push-only",
		...overrides,
	});
}

function installSendRequest(
	state: LSPClientState,
	handler: (method: string, params: unknown) => Promise<unknown>,
) {
	const mock = vi.fn(handler);
	state.connection.sendRequest =
		mock as unknown as typeof state.connection.sendRequest;
	return mock;
}

const skipEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_skipped_budget_exhausted");
const timeoutEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_diagnostic_timeout");
const rejectionEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_late_rejection");
const discardedEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_late_answer_discarded");

afterEach(() => {
	latencyEvents.length = 0;
	resetDegradationLedger();
	vi.useRealTimers();
});

describe("#1773 a budget-exhausted pull skips instead of dispatching an unwinnable request", () => {
	it("budgetMs <= 0: no request send, one skip record, no timeout record", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 0, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(0);
		expect(skipEvents()).toHaveLength(1);
		expect(timeoutEvents()).toHaveLength(0);

		const event = skipEvents()[0];
		expect(event.filePath).toBe(TEST_KEY);
		expect(event.metadata).toMatchObject({
			identifier: "bare",
			remainingBudgetMs: 0,
			server: "typescript",
		});

		// #1773 review: the skip is itself worth seeing in aggregate (a caller
		// that repeatedly hands out exhausted budgets), so it counts in the
		// ledger under its own kind — distinct from the genuine-timeout kind.
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-skipped-budget-exhausted",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toContain("typescript");
		expect(group?.latestReasons[0]?.subject).toContain(TEST_KEY);
	});

	it("negative budgetMs also skips (already-exhausted budget, not merely zero)", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, -50, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(0);
		expect(skipEvents()).toHaveLength(1);
	});

	// Mutation guard: deleting/loosening the `<` boundary would make a
	// below-floor budget dispatch too. 4ms is one below the floor and must
	// still skip.
	it("just below the floor (4ms) skips", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 4, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(0);
		expect(skipEvents()).toHaveLength(1);
	});

	// Mutation guard: deleting/loosening the `<` boundary would make the floor
	// value itself skip too. `PULL_MIN_USABLE_BUDGET_MS` (5ms) is named as the
	// smallest USABLE budget, so it must dispatch a genuine request, same as
	// the pre-existing 20ms/30ms fixtures — never skip.
	it("at the 5ms floor dispatches a real request (the floor is usable, not excluded)", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(
			state,
			(method) =>
				method !== "textDocument/diagnostic"
					? Promise.resolve(undefined)
					: new Promise(() => {}), // never resolves -> times out, not skipped
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 5, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(1);
		expect(skipEvents()).toHaveLength(0);
		expect(timeoutEvents()).toHaveLength(1);
	});

	it("well above the floor (6ms) also dispatches, not a boundary fluke", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(
			state,
			(method) =>
				method !== "textDocument/diagnostic"
					? Promise.resolve(undefined)
					: new Promise(() => {}), // never resolves -> times out, not skipped
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 6, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(1);
		expect(skipEvents()).toHaveLength(0);
		expect(timeoutEvents()).toHaveLength(1);
	});

	// Mutation guard: deleting the skip's `ledgerKind` would make this
	// undefined again — the exact #1771-shaped gap the review round flagged.
	it("does NOT count toward the genuine-timeout ledger kind — it has its own", async () => {
		const state = pullState();
		installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 0, { pullOnly: true });

		expect(
			getDegradationSummary().find(
				(g) => g.kind === "lsp-pull-diagnostic-timeout",
			),
		).toBeUndefined();
		expect(
			getDegradationSummary().find(
				(g) => g.kind === "lsp-pull-skipped-budget-exhausted",
			)?.count,
		).toBe(1);
	});
});

describe("#1774 a late server rejection after a pull timeout is a bounded, traced record", () => {
	it("fires exactly one lsp_pull_late_rejection record carrying the error code, server, and elapsed time", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			await wait(80);
			// -32803 (RequestFailed): permanent, unlike -32801 (ContentModified),
			// which `safeSendRequest` retries once and then resolves as `undefined`
			// rather than rejecting — so it would land in the late-ANSWER branch,
			// not this one. -32803 is the code the codebase's own comment
			// (`clients/lsp/client.ts`, `isContentModifiedError`) names as falling
			// through to a real rethrow, which is what this test needs to reach.
			const err = new Error("request failed") as Error & { code: number };
			err.code = -32803;
			throw err;
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		expect(rejectionEvents()).toHaveLength(0); // not settled yet

		await wait(120); // let the abandoned request settle

		expect(rejectionEvents()).toHaveLength(1);
		const event = rejectionEvents()[0];
		expect(event.filePath).toBe(TEST_KEY);
		expect(event.metadata).toMatchObject({
			identifier: "bare",
			server: "typescript",
			code: -32803,
		});
		expect(event.durationMs as number).toBeGreaterThanOrEqual(0);

		// Distinguishable from the late-ANSWER outcome, not conflated with it.
		expect(discardedEvents()).toHaveLength(0);

		const ledger = getDegradationSummary();
		const group = ledger.find((g) => g.kind === "lsp-pull-late-rejection");
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		// #1774 review: prefixed with the server, same shape as the timeout
		// kind's subject — mutation guard against dropping the `${server}::`
		// prefix and losing the discriminator between two servers.
		expect(group?.latestReasons[0]?.subject).toBe(`typescript::${TEST_KEY}`);
	});

	// Mutation guard: a rejection with no numeric/string `code` must still
	// record (never throw / never silently drop) — just without a `code` key.
	it("still records when the rejection carries no error code", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			await wait(80);
			throw new Error("connection reset");
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await wait(120);

		expect(rejectionEvents()).toHaveLength(1);
		expect(rejectionEvents()[0].metadata).not.toHaveProperty("code");
	});

	// Behavior-unchanged guard: the rejection must stay swallowed. This test
	// installs its OWN `process.on("unhandledRejection")` capture rather than
	// relying on vitest's global detector (review round: a handler that
	// rethrows still leaves every assertion above green, since nothing in
	// THIS test file asserted on the absence of an unhandled rejection —
	// vitest only fails the run via a separate top-level mechanism a
	// per-test `expect` never observes).
	it("does not change the swallow behavior — no unhandled rejection escapes", async () => {
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const state = pullState();
			installSendRequest(state, async (method) => {
				if (method !== "textDocument/diagnostic") return undefined;
				await wait(30);
				throw new Error("server rejected");
			});

			await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
			await wait(70);

			expect(rejectionEvents()).toHaveLength(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});
});

describe("#1773 class sweep: workspace/diagnostic shares the same budget-exhausted skip", () => {
	function workspacePullState(): LSPClientState {
		return createMockState({
			serverId: "typescript",
			root: "/project",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "static",
			},
		});
	}

	it("budgetMs <= 0: no workspace/diagnostic dispatch, one skip record, undefined result", async () => {
		const state = workspacePullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "workspace/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ items: [] }),
		);

		const result = await clientRequestWorkspaceDiagnostics(state, 0);

		const workspaceCalls = sendRequest.mock.calls.filter(
			([method]) => method === "workspace/diagnostic",
		);
		expect(workspaceCalls).toHaveLength(0);
		expect(result).toBeUndefined();
		expect(skipEvents()).toHaveLength(1);
		expect(timeoutEvents()).toHaveLength(0);
		expect(skipEvents()[0].metadata).toMatchObject({
			server: "typescript",
			remainingBudgetMs: 0,
		});

		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-skipped-budget-exhausted",
		);
		expect(group).toBeDefined();
		expect(group?.latestReasons[0]?.subject).toBe("typescript::*workspace*");
	});

	it("above the floor still dispatches a real workspace/diagnostic request", async () => {
		const state = workspacePullState();
		const sendRequest = installSendRequest(
			state,
			(method) =>
				method !== "workspace/diagnostic"
					? Promise.resolve(undefined)
					: new Promise(() => {}), // never resolves -> times out, not skipped
		);

		await clientRequestWorkspaceDiagnostics(state, 20);

		const workspaceCalls = sendRequest.mock.calls.filter(
			([method]) => method === "workspace/diagnostic",
		);
		expect(workspaceCalls).toHaveLength(1);
		expect(skipEvents()).toHaveLength(0);
		expect(timeoutEvents()).toHaveLength(1);
	});

	// #1774 review: the workspace call site's late-rejection `subject` is the
	// bare `WORKSPACE_PULL_SCOPE` constant, unlike the per-file site's
	// path-based subject — the exact case F4 named where two servers'
	// rejections would otherwise collapse into one ledger entry.
	it("a late workspace-pull rejection is also prefixed with the server", async () => {
		const state = workspacePullState();
		installSendRequest(state, async (method) => {
			if (method !== "workspace/diagnostic") return undefined;
			await wait(80);
			const err = new Error("request failed") as Error & { code: number };
			err.code = -32803;
			throw err;
		});

		await clientRequestWorkspaceDiagnostics(state, 20);
		await wait(120);

		expect(rejectionEvents()).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-late-rejection",
		);
		expect(group).toBeDefined();
		expect(group?.latestReasons[0]?.subject).toBe("typescript::*workspace*");
	});
});

describe("#1771 a genuine pull timeout counts in the degradation ledger", () => {
	it("increments lsp-pull-diagnostic-timeout with a server+file subject", async () => {
		const state = pullState();
		installSendRequest(
			state,
			(method) =>
				method !== "textDocument/diagnostic"
					? Promise.resolve(undefined)
					: new Promise(() => {}), // never resolves -> genuine timeout
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });

		expect(timeoutEvents()).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-diagnostic-timeout",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toContain("typescript");
		expect(group?.latestReasons[0]?.subject).toContain(TEST_KEY);
	});

	it("does not count a blocked repeat while the abandoned request is unsettled", async () => {
		const state = pullState();
		installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: new Promise(() => {}),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });

		// The first timeout occupies the per-source admission slot until its
		// request settles. The second caller is unavailable without dispatching,
		// so it is not a second genuine request timeout.
		expect(timeoutEvents()).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-diagnostic-timeout",
		);
		expect(group?.count).toBe(1);
	});

	// Mutation guard: a SKIPPED pull (budget already exhausted) must never
	// count toward this kind — only a genuinely dispatched-then-abandoned
	// request is a timeout.
	it("does NOT count a budget-exhausted skip toward the timeout kind", async () => {
		const state = pullState();
		installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 0, { pullOnly: true });

		expect(skipEvents()).toHaveLength(1);
		expect(
			getDegradationSummary().find(
				(g) => g.kind === "lsp-pull-diagnostic-timeout",
			),
		).toBeUndefined();
	});
});
