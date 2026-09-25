/**
 * #3375 — `safeSpawnAsync` caps retained output even when the caller passes no
 * `maxOutputBytes`, and a chunk handler that throws never escapes.
 *
 * The field defect: an omitted cap meant NO cap, so `appendOutput` fell through
 * to `current + text` and grew one JS string until V8 refused the next
 * concatenation with `RangeError: Invalid string length`. That throw is raised
 * inside a stdout/stderr `data` handler, where the awaiting caller's
 * `try`/`catch` cannot reach it, so it left the Pi host as an uncaught
 * exception and terminated it (Pi 0.86.1, 2026-09-22). 98 of the tree's 110
 * `safeSpawnAsync` call sites passed no cap.
 *
 * `node:child_process` is mocked here for the same reason
 * `safe-spawn-cap-race.test.ts` mocks it: the "child wrote enough to trip the
 * cap" signal becomes a synchronous `EventEmitter.emit("data", ...)` the test
 * issues itself, so the byte boundary and the handler-fault ordering are
 * decided by statement order rather than by an OS scheduler. The host-survival
 * half of the contract — a real child, a real pipe, a real 32 MiB of output —
 * is covered by a real spawn in `safe-spawn-ambient-signal.test.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";
import {
	DEFAULT_MAX_OUTPUT_BYTES,
	killedForOutputCap,
	truncatedByOutputCap,
} from "../../clients/spawn-output-cap.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";

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

const MiB = 1024 * 1024;
/** A real absolute path, so Windows command resolution never interferes. */
const COMMAND = process.execPath;
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Chunk = { stream: "stdout" | "stderr"; text: string };

/**
 * Drive one spawn whose child emits `chunks` and then exits cleanly. Every
 * emit is synchronous, so the cap boundary is reached at a statement the test
 * controls rather than at a moment the OS picks.
 */
async function runChild(
	chunks: Chunk[],
	options: Parameters<typeof safeSpawnAsync>[2] = {},
) {
	const child = makeFakeChild(4242);
	spawnMock.mockImplementation(() => {
		queueMicrotask(() => {
			for (const chunk of chunks) child[chunk.stream].emit("data", chunk.text);
			child.emit("exit", 0, null);
			child.emit("close", 0, null);
		});
		return child;
	});
	const pending = safeSpawnAsync(COMMAND, ["-e", ""], {
		timeout: 60_000,
		...options,
	});
	await vi.advanceTimersByTimeAsync(2000);
	return { child, result: await pending };
}

const oneMiBChunks = (
	count: number,
	stream: "stdout" | "stderr" = "stdout",
): Chunk[] =>
	Array.from({ length: count }, () => ({ stream, text: "x".repeat(MiB) }));

function pinPlatformAndKill(): {
	restore: () => void;
} {
	const realPlatform = process.platform;
	Object.defineProperty(process, "platform", {
		value: "linux",
		configurable: true,
	});
	// `child.pid` is fabricated; never send a real signal to a live process.
	const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
	return {
		restore: () => {
			Object.defineProperty(process, "platform", {
				value: realPlatform,
				configurable: true,
			});
			killSpy.mockRestore();
		},
	};
}

let pinned: ReturnType<typeof pinPlatformAndKill>;

beforeEach(() => {
	vi.useFakeTimers();
	pinned = pinPlatformAndKill();
	resetDegradationLedger();
});

afterEach(() => {
	pinned.restore();
	vi.useRealTimers();
	spawnMock.mockReset();
	resetDegradationLedger();
});

describe("safeSpawnAsync default output cap (#3375)", () => {
	// The boundary is `<=`, so exactly the default must still be retained whole:
	// a default that truncated AT its own value would silently shorten output
	// for all 98 previously-uncapped call sites.
	it("retains a child that stops exactly at the default cap, untruncated and unkilled", async () => {
		const { child, result } = await runChild(
			oneMiBChunks(DEFAULT_MAX_OUTPUT_BYTES / MiB),
		);

		expect(Buffer.byteLength(result.stdout)).toBe(DEFAULT_MAX_OUTPUT_BYTES);
		expect(result.outputTruncated).toBeUndefined();
		expect(result.killedForOutputCap).toBeUndefined();
		expect(child.kill).not.toHaveBeenCalled();
		expect(result.status).toBe(0);
	});

	// The defect direction: with no cap this child grew one string without limit.
	it("truncates and kills an uncapped child that passes the default cap", async () => {
		const { child, result } = await runChild(
			oneMiBChunks(DEFAULT_MAX_OUTPUT_BYTES / MiB + 1),
		);

		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(truncatedByOutputCap(result)).toBe(true);
		expect(killedForOutputCap(result)).toBe(true);
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_BYTES);
		expect(child.kill).toHaveBeenCalled();
	});

	// Both streams share one ceiling, and the cap must bite whichever one
	// crosses it — the field crash frame was a `Socket` handler with no
	// indication of which pipe it belonged to.
	it("counts stdout and stderr against one shared default ceiling", async () => {
		const half = DEFAULT_MAX_OUTPUT_BYTES / MiB / 2;
		const { result } = await runChild([
			...oneMiBChunks(half, "stdout"),
			...oneMiBChunks(half + 1, "stderr"),
		]);

		expect(result.outputTruncated).toBe(true);
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_BYTES);
	});

	// Pre-fix these four all resolved to "no cap at all" through the same
	// `Number.isFinite`/`> 0` validation arm. A caller that writes
	// `maxOutputBytes: someUnsetConfigValue` must land on the default, never on
	// unbounded retention.
	it.each([
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	])("falls back to the default when the cap is %s", async (_label, cap) => {
		const { result } = await runChild(
			oneMiBChunks(DEFAULT_MAX_OUTPUT_BYTES / MiB + 1),
			{ maxOutputBytes: cap },
		);

		expect(result.outputTruncated).toBe(true);
		const retained =
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
		expect(retained).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_BYTES);
		// Not 0 or 1 byte either: the DEFAULT is what applied, not the bad value.
		expect(retained).toBeGreaterThan(DEFAULT_MAX_OUTPUT_BYTES - 2 * MiB);
	});

	it("lets a caller's smaller explicit cap win over the default", async () => {
		const { result } = await runChild(
			[{ stream: "stdout", text: "x".repeat(4096) }],
			{ maxOutputBytes: 1024 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
	});

	it("lets a caller's larger explicit cap win over the default", async () => {
		const { result } = await runChild(
			oneMiBChunks(DEFAULT_MAX_OUTPUT_BYTES / MiB + 1),
			{ maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES + 8 * MiB },
		);

		expect(result.outputTruncated).toBeUndefined();
		expect(Buffer.byteLength(result.stdout)).toBe(
			DEFAULT_MAX_OUTPUT_BYTES + MiB,
		);
	});
});

/**
 * A `RegExp` whose `test` throws on the nth call. `matchWhileStreaming` is a
 * caller-supplied `RegExp` that the production handler calls once per chunk, so
 * this injects the fault at a real input of the seam under test rather than by
 * stubbing anything inside `safe-spawn.ts`. What it proves is the CLASS: any
 * throw inside the `data` handler — the field `RangeError` included — must
 * become a bounded result instead of an uncaught exception no caller can catch.
 */
class ThrowsOnNthTest extends RegExp {
	calls = 0;
	private readonly failOn: number;
	constructor(failOn: number) {
		super("never-matches-anything");
		this.failOn = failOn;
	}
	override test(): boolean {
		this.calls += 1;
		if (this.calls === this.failOn) {
			throw new RangeError("Invalid string length");
		}
		return false;
	}
}

describe("safeSpawnAsync output handler faults stay bounded (#3375)", () => {
	it("resolves a bounded cap result when a chunk handler throws", async () => {
		const matcher = new ThrowsOnNthTest(2);
		const { child, result } = await runChild(
			[
				{ stream: "stdout", text: "first chunk\n" },
				{ stream: "stdout", text: "second chunk\n" },
			],
			{ matchWhileStreaming: matcher },
		);

		// The already-retained bytes survive; nothing re-renders over them.
		expect(result.stdout).toContain("first chunk");
		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(child.kill).toHaveBeenCalled();
		const fault = getDegradationSummary().find(
			(group) => group.kind === "spawn-output-handler-fault",
		);
		expect(fault?.latestReasons[0]?.subject).toBe(COMMAND);
		expect(fault?.latestReasons[0]?.reason).toContain("threw RangeError");
	});

	it("skips later chunks instead of re-entering a handler that already threw", async () => {
		const matcher = new ThrowsOnNthTest(1);
		await runChild(
			[
				{ stream: "stdout", text: "a" },
				{ stream: "stdout", text: "b" },
				{ stream: "stderr", text: "c" },
			],
			{ matchWhileStreaming: matcher },
		);

		// One call: the throwing one. Chunks 2 and 3 returned before reaching it.
		expect(matcher.calls).toBe(1);
		const fault = getDegradationSummary().find(
			(group) => group.kind === "spawn-output-handler-fault",
		);
		expect(fault?.count).toBe(1);
	});
});

describe("safeSpawnAsync output-cap observability and output integrity (#3375)", () => {
	// The crash entry carried no command, no byte count and no cap value, so
	// nothing in it could name the chatty producer. This row is that answer, and
	// it is ONE counted row per command label however many chunks arrive — not
	// one per chunk, which is the unbounded-observability shape.
	it("records one counted cap row per command label, naming cap, bytes and kill", async () => {
		// Three chunks per run, so chunks keep arriving AFTER the cap trips —
		// which is what a real child does until the kill lands (see "retains
		// late output in the tail after an output-cap kill" in
		// safe-spawn-ambient-signal.test.ts). One row per RUN, not per chunk.
		const noisy = (fill: string) =>
			Array.from({ length: 3 }, () => ({
				stream: "stdout" as const,
				text: fill.repeat(4096),
			}));
		await runChild(noisy("x"), {
			maxOutputBytes: 1024,
			resourceLabel: "noisy-tool",
		});
		await runChild(noisy("y"), {
			maxOutputBytes: 1024,
			resourceLabel: "noisy-tool",
		});

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "spawn-output-cap-truncated",
		);
		expect(group?.count).toBe(2);
		expect(group?.latestReasons).toHaveLength(1);
		const row = group?.latestReasons[0];
		expect(row?.subject).toBe("noisy-tool");
		expect(row?.reason).toContain("1024-byte caller cap");
		expect(row?.reason).toContain("after 4096 bytes");
		expect(row?.reason).toContain("child terminated");
		expect(row?.reason).toContain("(count: 2)");
	});

	it("names the default as the cap source when the caller passed none", async () => {
		await runChild(oneMiBChunks(DEFAULT_MAX_OUTPUT_BYTES / MiB + 1), {
			resourceLabel: "uncapped-tool",
		});

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "spawn-output-cap-truncated",
		);
		expect(group?.latestReasons[0]?.reason).toContain(
			`${DEFAULT_MAX_OUTPUT_BYTES}-byte default cap`,
		);
	});

	// The field report saw NUL bytes in the interrupted run's files and did not
	// attribute them to pi-lens. Truncation slices at a BYTE offset, so it can
	// split a multi-byte UTF-8 sequence — that lands as U+FFFD, never as U+0000,
	// and the boundary is always marked for the caller.
	it("marks the truncation boundary and never emits NUL bytes for split UTF-8", async () => {
		const { result } = await runChild(
			[{ stream: "stdout", text: "é".repeat(2048) }],
			{ maxOutputBytes: 1025 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(result.stdout).toContain("[output truncated]");
		expect(result.stdout).not.toContain("\u0000");
		// 1025 is odd and U+00E9 is two UTF-8 bytes, so a boundary is split.
		expect(result.stdout).toContain("\uFFFD");
	});
});

/**
 * The default is a POLICY number, and the only measured evidence of legitimate
 * output volume in this tree is the caps maintainers already justified. A
 * default below any of them would truncate, by default, a consumer somebody
 * deliberately allowed more room for — this pins that direction so lowering the
 * default cannot pass silently (#3375).
 */
describe("DEFAULT_MAX_OUTPUT_BYTES versus the caps the tree already justifies", () => {
	it("is at least as large as every explicit maxOutputBytes in the tree", () => {
		// Digits, whitespace, `*`, `+` and parentheses only: arithmetic, never
		// evaluation of arbitrary tree source.
		const evaluate = (expression: string): number | undefined => {
			if (!/^[\d\s*+()]+$/.test(expression)) return undefined;
			const value = Function(
				`"use strict";return (${expression});`,
			)() as number;
			return Number.isFinite(value) ? value : undefined;
		};
		const explicit: Array<{ site: string; bytes: number }> = [];
		for (const directory of ["clients", "tools", "mcp", "scripts"]) {
			const root = path.join(REPO_ROOT, directory);
			if (!fs.existsSync(root)) continue;
			for (const absolute of listSourceFiles(root, { skipTests: true })) {
				const source = fs.readFileSync(absolute, "utf8");
				if (!source.includes("maxOutputBytes")) continue;
				const constants = new Map<string, number>();
				for (const match of source.matchAll(
					/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([\d\s*+()]+);/g,
				)) {
					const value = evaluate(match[2]);
					if (value !== undefined) constants.set(match[1], value);
				}
				for (const match of source.matchAll(
					/\bmaxOutputBytes\s*:\s*([A-Za-z_$][\w$]*|[\d\s*+()]+?)\s*[,}]/g,
				)) {
					const token = match[1].trim();
					const bytes = constants.get(token) ?? evaluate(token);
					if (bytes === undefined) continue;
					explicit.push({
						site: `${relativePosix(REPO_ROOT, absolute)}: ${token}`,
						bytes,
					});
				}
			}
		}
		// A class of size 0 would make this vacuous: the tree's own caps are the
		// whole evidence base for the number. 12 explicit caps on 2026-09-24;
		// half, rounded down, is the floor.
		assertNonEmptyScan("explicit maxOutputBytes caps", explicit.length, 6);
		expect(
			explicit
				.filter((entry) => entry.bytes > DEFAULT_MAX_OUTPUT_BYTES)
				.map((entry) => entry.site),
		).toEqual([]);
	});
});
