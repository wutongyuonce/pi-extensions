/**
 * #2524: `terminateScannerChild` (clients/instance-reaper.ts) hardcoded the
 * kind `orphan-backstop-scanner-escalated` for EVERY caller, but it has two
 * callers with different budgets and cadences — the registry-independent
 * orphan backstop (one scan per cooldown window, `BACKSTOP_SCAN_TIMEOUT_MS`
 * 5000ms) and the resource sampler's process-table queries
 * (`RESOURCE_SAMPLE_QUERY_TIMEOUT_MS` 2000ms, fired on every
 * heartbeat/spawn-bracket tick). Every sampler-path escalation was therefore
 * recorded under the backstop's kind — 8 rows observed live while the
 * backstop provably had not run (defect shape: a record's subject must be
 * its producer).
 *
 * This drives the REAL production call path: `resource-sampler.ts`'s
 * `sampleProcesses` (Windows/guarded-CIM branch) through a REAL
 * `RESOURCE_SAMPLE_QUERY_TIMEOUT_MS` timeout into the REAL, UNMOCKED
 * `terminateScannerChild` (clients/instance-reaper.js) and its REAL
 * tree-kill-and-verify machinery — never a hand-fed call to
 * `terminateScannerChild` itself. Only `node:child_process`'s `spawn` and
 * `process.kill` are mocked (same technique as
 * tests/clients/instance-reaper-backstop.test.ts), so no real OS process is
 * ever touched and no real kill signal is ever sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnRecord {
	command: string;
	args: string[];
}

const h = vi.hoisted(() => {
	const spawns: SpawnRecord[] = [];
	const state: {
		/** The scanner query child never settles — exercises the caller's
		 *  own RESOURCE_SAMPLE_QUERY_TIMEOUT_MS timeout. */
		hangQuery: boolean;
		/** pids the fake `process.kill(pid, 0)` probe reports as alive. */
		alivePids: Set<number>;
	} = {
		hangQuery: false,
		alivePids: new Set<number>(),
	};
	let nextPid = 70_000;
	function makeFakeChild(command: string, _args: string[]) {
		const isQuery = command.toLowerCase().includes("powershell");
		const pid = nextPid++;
		const stdoutHandlers: Array<(chunk: string) => void> = [];
		const handlers = new Map<string, (...a: unknown[]) => void>();
		const child = {
			pid,
			stdout: {
				on(event: string, cb: (chunk: string) => void) {
					if (event === "data") stdoutHandlers.push(cb);
				},
				unref() {},
			},
			stderr: null,
			stdin: null,
			unref() {},
			kill() {},
			once(event: string, cb: (...a: unknown[]) => void) {
				handlers.set(event, cb);
				if (isQuery && h.state.hangQuery) return child; // never settles
				if (event === "close") {
					queueMicrotask(() => cb(0, null));
				}
				return child;
			},
		};
		return child;
	}
	return { spawns, state, makeFakeChild };
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn((command: string, args: string[]) => {
		h.spawns.push({ command, args });
		return h.makeFakeChild(command, args);
	}),
}));

const {
	getDegradationSummary,
	renderDegradationLines,
	resetDegradationLedger,
} = await import("../../clients/degradation-ledger.js");
const {
	sampleProcesses,
	sampleProcessTreeCpuPercent,
	__resetWindowsCpuHistoryForTests,
} = await import("../../clients/resource-sampler.js");
const { RESOURCE_SAMPLE_QUERY_TIMEOUT_MS } =
	await import("../../clients/resource-sampler.js");

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

function reasonsFor(kind: string): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary().find((g) => g.kind === kind)?.latestReasons ?? []
	);
}

beforeEach(() => {
	h.spawns.length = 0;
	h.state.hangQuery = false;
	h.state.alivePids = new Set<number>();
	setPlatform("win32");
	resetDegradationLedger();
	__resetWindowsCpuHistoryForTests();
	vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
		if (h.state.alivePids.has(Math.abs(pid))) return true;
		const err = new Error("no such process") as NodeJS.ErrnoException;
		err.code = "ESRCH";
		throw err;
	}) as unknown as typeof process.kill);
});

afterEach(() => {
	setPlatform(realPlatform);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("#2524: resource-sampler scanner escalation is attributed to its own producer", () => {
	it("records resource-sampler-scanner-escalated (with its own 2000ms budget) instead of the orphan backstop's kind", async () => {
		vi.useFakeTimers();
		h.state.hangQuery = true;

		const query = sampleProcesses([111]);
		await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_QUERY_TIMEOUT_MS + 1_000);
		await query;

		// The mis-attribution this issue fixes: pre-fix, EVERY escalation —
		// backstop and sampler alike — landed under this kind.
		expect(reasonsFor("orphan-backstop-scanner-escalated")).toHaveLength(0);

		const reasons = reasonsFor("resource-sampler-scanner-escalated");
		expect(reasons).toHaveLength(1);
		expect(reasons[0].reason).toContain(
			`${RESOURCE_SAMPLE_QUERY_TIMEOUT_MS}ms`,
		);
		// The scanner query child, not pid 111 (the sampling TARGET) — the
		// escalation's subject is the scanner that was killed.
		expect(reasons[0].subject).not.toContain("#111");
	});

	it("renders the sampler's escalation informationally (no ⚠), unlike the backstop's warning tier", async () => {
		vi.useFakeTimers();
		h.state.hangQuery = true;

		const query = sampleProcesses([222]);
		await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_QUERY_TIMEOUT_MS + 1_000);
		await query;

		const lines = renderDegradationLines();
		const samplerLine = lines.find((line) =>
			line.includes("resource-sampler-scanner-escalated"),
		);
		expect(samplerLine).toBeDefined();
		expect(samplerLine).not.toContain("⚠");
	});

	// #2527 review F1: `sampleProcesses`/`sampleProcessesWindows` above only
	// exercises ONE of the sampler's two `terminateScannerChild` call sites.
	// `findDescendantPidsWindows` (the pid/ppid descendant-tree query, used by
	// `sampleProcessTreeCpuPercent` and `startSpawnUsageSampler` to resolve a
	// Windows `shell:true` spawn's real worker pids) has its OWN `onTimeout`
	// wiring a few lines above `sampleProcessesWindows`'s — reverting only that
	// call site back to the pre-#2524 hardcoded kind must turn a test red, or
	// the second call site is unguarded coverage.
	it("also attributes the descendant-pid query's (findDescendantPidsWindows) escalation to the sampler's own kind", async () => {
		vi.useFakeTimers();
		h.state.hangQuery = true;

		// windowMs=50 keeps the second (post-window) read's own query timeout
		// the only slow leg to advance past; floorPercent is irrelevant since
		// the query never resolves.
		const resultPromise = sampleProcessTreeCpuPercent(444, 50, 10);
		// First read's descendant-pid query times out.
		await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_QUERY_TIMEOUT_MS + 1_000);
		// The inter-read window elapses, firing the second read, whose
		// descendant-pid query also times out.
		await vi.advanceTimersByTimeAsync(
			50 + RESOURCE_SAMPLE_QUERY_TIMEOUT_MS + 1_000,
		);
		const result = await resultPromise;

		// Both queries were unresolvable, so the tree-CPU read itself is unmeasured.
		expect(result.measured).toBe(false);

		expect(reasonsFor("orphan-backstop-scanner-escalated")).toHaveLength(0);
		const reasons = reasonsFor("resource-sampler-scanner-escalated");
		// Two reads, each triggering one escalation of the descendant-pid query.
		expect(reasons.length).toBeGreaterThanOrEqual(1);
		for (const reason of reasons) {
			expect(reason.reason).toContain(`${RESOURCE_SAMPLE_QUERY_TIMEOUT_MS}ms`);
		}
	});
});
