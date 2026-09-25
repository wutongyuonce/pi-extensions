/**
 * #3375 round 2 (review finding H3384-1) — a teardown whose signals are all
 * refused is a bounded result, never a pending promise, an `unhandledRejection`
 * or an uncaught exception.
 *
 * Round 1 made the stdout/stderr chunk handler total, but its teardown
 * dependency was not. `killTree`'s promise is reached three structurally
 * different ways, and a throwing `kill` escaped through each of them:
 *
 * 1. `killPromise = killTree(...)` from the output-cap, handler-fault and
 *    timeout paths, awaited by `finalize` — which runs as `void finalize(...)`,
 *    so the rejection left the PUBLIC SPAWN PROMISE UNSETTLED FOREVER and
 *    surfaced as an `unhandledRejection`. That is the reviewer's reproduction.
 * 2. `void killTree("abort")` from `onAbort` — nothing awaits it, so the
 *    rejection leaks even if `finalize` guards its own await. A remedy applied
 *    only at `finalize` does not reach this one.
 * 3. `child.kill("SIGKILL")` inside the escalation `setTimeout` — a bare timer
 *    callback, where a throw is an UNCAUGHT EXCEPTION rather than a rejection.
 *    That is the same escape shape #3375 itself exists to close, and it is the
 *    other one a `finalize`-only remedy cannot see.
 *
 * So every signal now goes through `trySend`, and these cases pin all three
 * doors. `node:child_process` is mocked (the `fake-child.ts` double, as
 * `safe-spawn-cap-race.test.ts` does) so the kill seam is a function this test
 * controls and the escalation timer fires on a statement rather than on a
 * wall-clock second. The fake child drives the non-group branch — `/proc`
 * cannot prove ownership of its fabricated pid, exactly as on every macOS host
 * — which is where doors 2 and 3 live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	spawnSync: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
}));

vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: () => ({ stop: () => null }),
}));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: () => {},
}));

const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

const COMMAND = process.execPath;
const REFUSED = "injected kill refusal";

/** A matcher whose `test` throws: the production handler-fault path. */
class ThrowsOnFirstTest extends RegExp {
	constructor() {
		super("never-matches-anything");
	}
	override test(): boolean {
		throw new RangeError("Invalid string length");
	}
}

let realPlatform: string;
let killSpy: ReturnType<typeof vi.spyOn>;
/** Rejections nobody handled, captured for the duration of one case. */
let leaked: string[];
let onLeak: (reason: unknown) => void;

beforeEach(() => {
	vi.useFakeTimers();
	realPlatform = process.platform;
	Object.defineProperty(process, "platform", {
		value: "linux",
		configurable: true,
	});
	// Every `process.kill` in these cases is refused, except the liveness probe
	// (signal 0), which must stay answerable. `child.pid` is fabricated, so a
	// real signal must never be sent either way.
	killSpy = vi.spyOn(process, "kill").mockImplementation(((
		_pid: number,
		signal?: string | number,
	) => {
		if (signal === 0) return true;
		throw new Error(REFUSED);
	}) as typeof process.kill);
	leaked = [];
	onLeak = (reason) => {
		leaked.push(String((reason as Error)?.message ?? reason));
	};
	process.on("unhandledRejection", onLeak);
	resetDegradationLedger();
});

afterEach(() => {
	process.off("unhandledRejection", onLeak);
	Object.defineProperty(process, "platform", {
		value: realPlatform,
		configurable: true,
	});
	killSpy.mockRestore();
	vi.useRealTimers();
	spawnMock.mockReset();
	resetDegradationLedger();
});

/** A fake child whose `kill` throws for the signals named in `refuse`. */
function childRefusing(refuse: readonly string[]) {
	const child = makeFakeChild(4242);
	child.kill = vi.fn((signal?: unknown) => {
		if (refuse.includes(String(signal))) throw new Error(REFUSED);
		child.killed = true;
		return true;
	});
	return child;
}

function killFailureRows() {
	return getDegradationSummary().find(
		(group) => group.kind === "spawn-kill-failed",
	);
}

describe("safeSpawnAsync teardown whose signals are all refused (#3375 H3384-1)", () => {
	// Door 1, the reviewer's reproduction: a handler fault kills the child, the
	// kill is refused, and pre-fix the returned promise never settled at all.
	it("settles a bounded result when the handler-fault kill is refused", async () => {
		const child = childRefusing(["SIGTERM", "SIGKILL"]);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit("data", "chatter");
				child.emit("exit", 0, null);
				child.emit("close", 0, null);
			});
			return child;
		});

		let settled = false;
		const pending = safeSpawnAsync(COMMAND, ["-e", ""], {
			timeout: 60_000,
			matchWhileStreaming: new ThrowsOnFirstTest(),
			resourceLabel: "refusing-tool",
		}).then((value) => {
			settled = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(5000);

		// Pre-fix this is where it stops: `settled` stays false forever.
		expect(settled).toBe(true);
		const result = await pending;
		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(result.killFailed).toBe(true);
		expect(leaked).toEqual([]);
		const rows = killFailureRows();
		expect(rows?.count).toBe(1);
		expect(rows?.latestReasons[0]?.subject).toBe("refusing-tool");
		expect(rows?.latestReasons[0]?.reason).toContain("handler-fault teardown");
	});

	// Door 1 again, through the ordinary output-cap teardown rather than a fault:
	// the same `await killPromise` inside `void finalize(...)`.
	it("settles a bounded result when the output-cap kill is refused", async () => {
		const child = childRefusing(["SIGTERM", "SIGKILL"]);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit("data", "x".repeat(4096));
				child.emit("exit", 0, null);
				child.emit("close", 0, null);
			});
			return child;
		});

		let settled = false;
		const pending = safeSpawnAsync(COMMAND, ["-e", ""], {
			timeout: 60_000,
			maxOutputBytes: 1024,
			resourceLabel: "refusing-tool",
		}).then((value) => {
			settled = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(5000);

		expect(settled).toBe(true);
		const result = await pending;
		expect(result.outputTruncated).toBe(true);
		expect(result.killFailed).toBe(true);
		expect(leaked).toEqual([]);
		expect(killFailureRows()?.latestReasons[0]?.reason).toContain(
			"output-cap teardown",
		);
	});

	// Door 2. `onAbort` does `void killTree("abort")`, so a remedy that only
	// guards `finalize`'s own await still leaks this rejection.
	it("leaks no rejection when the abort-path kill is refused", async () => {
		const child = childRefusing(["SIGTERM", "SIGKILL"]);
		spawnMock.mockImplementation(() => child);
		const controller = new AbortController();

		const pending = safeSpawnAsync(COMMAND, ["-e", ""], {
			timeout: 60_000,
			signal: controller.signal,
			resourceLabel: "refusing-tool",
		});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.advanceTimersByTimeAsync(2000);
		child.emit("exit", null, "SIGTERM");
		child.emit("close", null, "SIGTERM");
		const result = await pending;

		expect(leaked).toEqual([]);
		expect(result.killFailed).toBe(true);
		expect(result.failure).toBe("aborted");
		expect(killFailureRows()?.latestReasons[0]?.reason).toContain(
			"abort teardown",
		);
	});

	// Door 3. The escalation runs in a bare `setTimeout` callback, so a throw
	// there is an uncaught exception, not a rejection — under fake timers it
	// surfaces out of `advanceTimersByTimeAsync` instead, which reds this case
	// the same way. SIGTERM is accepted so the timer is actually armed; only the
	// escalation is refused.
	it("raises nothing from the timer when only the SIGKILL escalation is refused", async () => {
		const child = childRefusing(["SIGKILL"]);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit("data", "x".repeat(4096));
			});
			return child;
		});

		const pending = safeSpawnAsync(COMMAND, ["-e", ""], {
			timeout: 60_000,
			maxOutputBytes: 1024,
			resourceLabel: "refusing-tool",
		});
		// The child neither exits nor closes, so `closed` is false when the
		// 1000 ms escalation fires and the refused SIGKILL is actually sent.
		await vi.advanceTimersByTimeAsync(1500);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");

		child.emit("exit", null, "SIGTERM");
		child.emit("close", null, "SIGTERM");
		const result = await pending;

		expect(leaked).toEqual([]);
		expect(result.killFailed).toBe(true);
		expect(killFailureRows()?.count).toBe(1);
	});

	// The reviewer's reproduction refused TWO kills — the fault's, then the
	// timeout's — so the row is latched per spawn rather than per attempt.
	it("records the failed teardown once when two teardowns are both refused", async () => {
		const child = childRefusing(["SIGTERM", "SIGKILL"]);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit("data", "x".repeat(4096));
			});
			return child;
		});

		const pending = safeSpawnAsync(COMMAND, ["-e", ""], {
			timeout: 1000,
			maxOutputBytes: 1024,
			resourceLabel: "refusing-tool",
		});
		// The cap kill is refused, then the timeout budget expires and its kill
		// is refused too.
		await vi.advanceTimersByTimeAsync(3000);
		child.emit("exit", null, "SIGTERM");
		child.emit("close", null, "SIGTERM");
		const result = await pending;

		expect(leaked).toEqual([]);
		expect(result.killFailed).toBe(true);
		expect(killFailureRows()?.count).toBe(1);
	});

	// The 4.2.1 shape: `killFailed` is absent unless a teardown actually failed,
	// so an old result and every fixture in `tests/support/spawn-shapes.ts` still
	// parse and no consumer sees a new key on a healthy run.
	it("leaves killFailed absent when the kill is accepted", async () => {
		const child = childRefusing([]);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit("data", "x".repeat(4096));
				child.emit("exit", null, "SIGTERM");
				child.emit("close", null, "SIGTERM");
			});
			return child;
		});

		const result = await (async () => {
			const pending = safeSpawnAsync(COMMAND, ["-e", ""], {
				timeout: 60_000,
				maxOutputBytes: 1024,
			});
			await vi.advanceTimersByTimeAsync(2000);
			return pending;
		})();

		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(result.killFailed).toBeUndefined();
		expect("killFailed" in result).toBe(false);
		expect(killFailureRows()).toBeUndefined();
		expect(leaked).toEqual([]);
	});
});
