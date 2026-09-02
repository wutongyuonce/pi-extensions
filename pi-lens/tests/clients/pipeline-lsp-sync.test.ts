/**
 * The pre-dispatch LSP sync (`resyncLspFile`) must never let a wedged language
 * server hang the edit. Its didChange/didOpen write can backpressure forever
 * when the server's stdin isn't drained, so the sync is bounded by a hard budget
 * (PI_LENS_LSP_SYNC_BUDGET_MS) and the turn's abort signal (Escape) — whichever
 * wins, resyncLspFile returns and the edit proceeds. Regression guard for the
 * "8h invisible edit hang" class.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatedPromise, starveBudget } from "../support/fault-injection.js";

vi.mock("../../clients/lsp/index.js", () => ({ getLSPService: vi.fn() }));

const logLatencyMock = vi.fn();

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency: (entry: unknown) => logLatencyMock(entry),
}));

import { resyncLspFile } from "../../clients/pipeline.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";

const getFlag = () => undefined;
const dbg = () => {};

function mockService(
	touchFile: () => Promise<unknown>,
	isSpawnInFlight: () => boolean = () => false,
) {
	vi.mocked(getLSPService).mockReturnValue({
		supportsLSP: () => true,
		touchFile: vi.fn(touchFile),
		isSpawnInFlight: vi.fn(isSpawnInFlight),
	} as any);
}

beforeEach(() => {
	starveBudget("PI_LENS_LSP_SYNC_BUDGET_MS", 50);
	setAmbientAbortSignal(undefined);
	logLatencyMock.mockClear();
});
afterEach(() => {
	delete process.env.PI_LENS_LSP_SYNC_BUDGET_MS;
	setAmbientAbortSignal(undefined);
	vi.restoreAllMocks();
});

describe("resyncLspFile — bounded pre-dispatch LSP sync", () => {
	it("abandons a wedged touch after the budget instead of hanging", async () => {
		// touchFile that never resolves = a server whose didChange write backpressures.
		// Kit-gated (#1838): the wedge is an explicit gatedPromise, so "the budget
		// fired before the work completed" holds on any scheduler, any load.
		const gate = gatedPromise<unknown>();
		mockService(() => gate.promise);
		const started = Date.now();
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(2000); // returned, did not hang
		gate.resolve(null); // release the gate so nothing dangles into teardown
	});

	it("returns immediately when the turn is already aborted, without touching", async () => {
		const controller = new AbortController();
		controller.abort();
		setAmbientAbortSignal(controller.signal);
		const touch = vi.fn(() => new Promise(() => {}));
		mockService(touch);
		const started = Date.now();
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		expect(Date.now() - started).toBeLessThan(30);
		expect(touch).not.toHaveBeenCalled();
	});

	it("bails as soon as Escape aborts mid-flight (before the budget)", async () => {
		mockService(() => new Promise(() => {}));
		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		process.env.PI_LENS_LSP_SYNC_BUDGET_MS = "10000"; // long, so abort wins the race
		const started = Date.now();
		const p = resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		setTimeout(() => controller.abort(), 30);
		await p;
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("completes normally (fast) when the server is healthy", async () => {
		const touch = vi.fn(() => Promise.resolve([]));
		mockService(touch);
		const started = Date.now();
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		expect(Date.now() - started).toBeLessThan(45); // resolved well before the budget
		expect(touch).toHaveBeenCalledTimes(1);
	});

	// #1766: the resync deadline can expire while the target server's FIRST
	// spawn is still in flight (a cold spawn slower than the budget). The old
	// wording blamed that server as "slow/wedged" — a verdict about a running
	// server — even though it did not exist yet. Synthesize the race
	// deterministically via isSpawnInFlight rather than real spawn timing.
	it("reports spawn-in-flight, not slow/wedged, when the deadline fires during the server's first spawn", async () => {
		const dbgCalls: string[] = [];
		const dbgSpy = (msg: string) => dbgCalls.push(msg);
		mockService(
			() => new Promise(() => {}), // touch never resolves within the test
			() => true, // the target server's spawn is still unresolved
		);
		await resyncLspFile(
			"/proj/new.json",
			"content",
			true,
			false,
			getFlag,
			dbgSpy,
		);

		const joined = dbgCalls.join("\n");
		expect(joined).toContain("spawn-in-flight");
		expect(joined).not.toContain("slow/wedged");

		const abandoned = logLatencyMock.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry.phase === "lsp_sync_abandoned");
		expect(abandoned?.metadata?.reason).toBe("spawn-in-flight");
		expect(abandoned?.filePath).toBe("/proj/new.json");
	});

	it("still reports slow/wedged when no spawn is in flight (a genuinely stalled running server)", async () => {
		const dbgCalls: string[] = [];
		const dbgSpy = (msg: string) => dbgCalls.push(msg);
		mockService(
			() => new Promise(() => {}),
			() => false, // no spawn pending — this server is already running
		);
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbgSpy);

		const joined = dbgCalls.join("\n");
		expect(joined).toContain("slow/wedged");
		expect(joined).not.toContain("spawn-in-flight");

		const abandoned = logLatencyMock.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry.phase === "lsp_sync_abandoned");
		expect(abandoned?.metadata?.reason).toBe("timeout");
	});

	// #1766 review F3: a service double (or a future service shape) that lacks
	// isSpawnInFlight must not throw. An unguarded call throws into the
	// swallow-all catch in resyncLspFile, which suppresses the
	// lsp_sync_abandoned record entirely — a stall that used to be logged
	// (even with the wrong reason) would go completely silent.
	it("degrades to the old timeout wording, without throwing, when the service lacks isSpawnInFlight", async () => {
		const dbgCalls: string[] = [];
		const dbgSpy = (msg: string) => dbgCalls.push(msg);
		vi.mocked(getLSPService).mockReturnValue({
			supportsLSP: () => true,
			touchFile: vi.fn(() => new Promise(() => {})),
			// isSpawnInFlight intentionally omitted — partial double / older shape.
		} as any);

		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbgSpy);

		const joined = dbgCalls.join("\n");
		expect(joined).toContain("slow/wedged");
		expect(joined).not.toContain("after autofix error"); // did not fall into the catch

		const abandoned = logLatencyMock.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry.phase === "lsp_sync_abandoned");
		expect(abandoned).toBeDefined();
		expect(abandoned?.metadata?.reason).toBe("timeout");
	});
});
