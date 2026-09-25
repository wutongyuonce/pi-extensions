/**
 * #3383 — the stream `data` handlers that never reach `safeSpawnAsync` now
 * accumulate under a bound.
 *
 * ## The recurrence these guard
 *
 * #3375's field defect: an unbounded `current + text` inside a stdout `data`
 * handler grew one JS string until V8 refused the next concatenation with
 * `RangeError: Invalid string length`. A throw raised in a `data` handler is
 * delivered to the process, not to the awaiting caller, so it terminated the Pi
 * host (Pi 0.86.1, 2026-09-22). #3375 fixed the shared spawn seam; the class
 * sweep for it found these three producers that bypass that seam entirely — a
 * forked analyze worker, the unref'd one-shot collector (which is what
 * `safe-spawn.ts` itself depends on, so it can never route through it) and the
 * installer's interpreter user-base probes.
 *
 * `node:child_process` is mocked for the same reason
 * `safe-spawn-default-output-cap.test.ts` mocks it: "the child wrote enough to
 * trip the bound" becomes a synchronous `emit("data", …)` this test issues, so
 * the byte boundary is decided by statement order rather than by an OS
 * scheduler. The producers here are pipes; the axis under test is the
 * accumulation, and the double is faithful on that axis (real `EventEmitter`
 * streams, real chunk delivery).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeChild } from "../support/fake-child.js";
import {
	createBoundedOutputSink,
	DEFAULT_MAX_OUTPUT_BYTES,
} from "../../clients/spawn-output-cap.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		default: actual,
		spawn: (...args: unknown[]) => spawnMock(...args),
	};
});

const { analyzeFileFresh } = await import("../../clients/mcp/review.js");
const { spawnCollectStdoutResult } =
	await import("../../clients/child-unref.js");
const { userBaseProbeResult } =
	await import("../../clients/installer/index.js");
const { getDegradationSummary, resetDegradationLedger } =
	await import("../../clients/degradation-ledger.js");

const MiB = 1024 * 1024;
/** One chunk; five of them cross the 32 MiB default bound. */
const CHUNK = "x".repeat(8 * MiB);

function ledgerRow(kind: string) {
	return getDegradationSummary().find((entry) => entry.kind === kind);
}

beforeEach(() => {
	vi.useFakeTimers();
	resetDegradationLedger();
	spawnMock.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	resetDegradationLedger();
});

describe("createBoundedOutputSink (#3383)", () => {
	it("stops retaining past the bound and reports what the producer emitted", () => {
		const sink = createBoundedOutputSink(10);
		sink.append("12345");
		sink.append(Buffer.from("67890"));
		expect(sink.truncated).toBe(false);
		expect(sink.text).toBe("1234567890");
		sink.append("!");
		expect(sink.truncated).toBe(true);
		expect(sink.text).toBe("1234567890");
		expect(sink.observedBytes).toBe(11);
	});

	it("retains everything that fits, so the bound is not a blanket refusal", () => {
		const sink = createBoundedOutputSink(10);
		sink.append("héllo");
		expect(sink.text).toBe("héllo");
		expect(sink.truncated).toBe(false);
		// Bytes, not characters: "é" is two of them.
		expect(sink.observedBytes).toBe(6);
	});
});

describe("analyzeFileFresh output bound (#3383)", () => {
	function driveWorker(
		chunks: Array<{ stream: "stdout" | "stderr"; text: string }>,
		exitCode = 0,
	) {
		const child = makeFakeChild(4242);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				for (const chunk of chunks)
					child[chunk.stream].emit("data", chunk.text);
				child.emit("close", exitCode);
			});
			return child;
		});
		const pending = analyzeFileFresh("/w/worker.js", "/w/a.ts", "/w");
		return { child, pending };
	}

	it("bounds a worker that writes without end, kills it, and records the trip", async () => {
		const { child, pending } = driveWorker(
			Array.from({ length: 5 }, () => ({
				stream: "stdout" as const,
				text: CHUNK,
			})),
		);
		await vi.advanceTimersByTimeAsync(10);
		const outcome = await pending;
		expect(outcome.result).toBeUndefined();
		expect(outcome.error).toBe(
			`worker output exceeded ${DEFAULT_MAX_OUTPUT_BYTES} bytes`,
		);
		expect(child.kill).toHaveBeenCalled();
		const row = ledgerRow("spawn-output-cap-truncated");
		expect(row?.count).toBe(1);
		expect(row?.latestReasons[0]?.subject).toBe("mcp-fresh-analyze");
		expect(row?.latestReasons[0]?.reason).toContain("worker terminated");
	});

	it("still returns a normal worker result, so the bound is not a blanket refusal", async () => {
		const { pending } = driveWorker([
			{ stream: "stdout", text: JSON.stringify({ filePath: "/w/a.ts" }) },
		]);
		await vi.advanceTimersByTimeAsync(10);
		const outcome = await pending;
		expect(outcome.result).toEqual({ filePath: "/w/a.ts" });
		expect(ledgerRow("spawn-output-cap-truncated")).toBeUndefined();
	});

	it("retains nothing after the outcome has settled", async () => {
		const child = makeFakeChild(4242);
		spawnMock.mockImplementation(() => child);
		const pending = analyzeFileFresh(
			"/w/worker.js",
			"/w/a.ts",
			"/w",
			{},
			1_000,
		);
		await vi.advanceTimersByTimeAsync(2_000);
		const outcome = await pending;
		expect(outcome.error).toContain("timed out");
		// A child that outlives its own timeout keeps writing into a pipe nobody
		// awaits: every byte after the settle is retention with no reader.
		for (let i = 0; i < 5; i++) child.stdout.emit("data", CHUNK);
		expect(ledgerRow("spawn-output-cap-truncated")).toBeUndefined();
	});
});

describe("spawnCollectStdoutResult output bound (#3383)", () => {
	function driveCollector(chunks: string[]) {
		const child = makeFakeChild(4242);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				for (const chunk of chunks) child.stdout.emit("data", chunk);
				child.emit("close", 0, null);
			});
			return child;
		});
		return spawnCollectStdoutResult("ps", ["-eo", "pid"], {});
	}

	it("bounds a process-table query that never ends", async () => {
		const pending = driveCollector(Array.from({ length: 5 }, () => CHUNK));
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;
		expect(result.status).toBe("ok");
		expect(Buffer.byteLength(result.stdout)).toBe(DEFAULT_MAX_OUTPUT_BYTES);
	});

	it("keeps a small table intact, so the bound is not a blanket refusal", async () => {
		const pending = driveCollector(["  PID\n 1234\n"]);
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;
		expect(result).toEqual({ stdout: "  PID\n 1234\n", status: "ok" });
	});
});

describe("userBaseProbeResult (#3383)", () => {
	it("resolves empty and records the trip when an interpreter floods the probe", () => {
		const sink = createBoundedOutputSink(10);
		sink.append("/home/u/.local");
		expect(userBaseProbeResult("python3", 0, sink)).toBe("");
		const row = ledgerRow("spawn-output-cap-truncated");
		expect(row?.count).toBe(1);
		expect(row?.latestReasons[0]?.subject).toBe("user-base-probe:python3");
	});

	it("returns the trimmed path from a healthy probe", () => {
		const sink = createBoundedOutputSink();
		sink.append("/home/u/.local\n");
		expect(userBaseProbeResult("python3", 0, sink)).toBe("/home/u/.local");
		expect(userBaseProbeResult("python3", 1, sink)).toBe("");
		expect(ledgerRow("spawn-output-cap-truncated")).toBeUndefined();
	});
});
