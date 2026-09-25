import { afterEach, describe, expect, it } from "vitest";
import {
	_stopEventLoopMonitorForTest,
	classifyLoopBlock,
	getEventLoopStats,
	isSuspendSuspectedBlock,
	resetEventLoopMonitor,
	shouldLogLoopBlock,
	shouldLogWorstBlock,
	startEventLoopMonitor,
} from "../../clients/event-loop-monitor.js";

// Note: the actual *capture* of a synchronous block is Node's native
// `monitorEventLoopDelay` (its libuv timer is unreliable inside vitest's worker,
// but verified manually: a 200ms busy-loop yields max≈200ms on a live loop).
// These cover our wrapper's contract — lifecycle, finite-stat conversion, reset.

afterEach(() => {
	_stopEventLoopMonitorForTest();
});

const settle = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("event-loop-monitor", () => {
	it("returns undefined before it is started", () => {
		expect(getEventLoopStats()).toBeUndefined();
	});

	it("reports finite occupancy stats once started", async () => {
		startEventLoopMonitor(10);
		await settle(40); // let it sample a few intervals
		const s = getEventLoopStats();
		expect(s).toBeDefined();
		expect(Number.isFinite(s?.maxMs)).toBe(true);
		expect(Number.isFinite(s?.p99Ms)).toBe(true);
		expect(Number.isFinite(s?.meanMs)).toBe(true);
		expect(s?.maxMs).toBeGreaterThanOrEqual(0);
	});

	it("exposes per-window CPU/wall accounting and a stall flag (#1122)", async () => {
		startEventLoopMonitor(10);
		await settle(40);
		const s = getEventLoopStats();
		expect(Number.isFinite(s?.windowWallMs)).toBe(true);
		expect(Number.isFinite(s?.windowCpuMs)).toBe(true);
		expect(s?.windowWallMs).toBeGreaterThanOrEqual(0);
		expect(s?.windowCpuMs).toBeGreaterThanOrEqual(0);
		// A live loop with a real (tiny) block is never a system stall.
		expect(s?.suspectSystemStall).toBe(false);
	});

	it("reset does not throw and keeps stats queryable", async () => {
		startEventLoopMonitor(10);
		await settle(20);
		resetEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
	});

	it("start is idempotent", () => {
		startEventLoopMonitor();
		startEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
	});

	it("_stopEventLoopMonitorForTest clears the monitor", () => {
		startEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
		_stopEventLoopMonitorForTest();
		expect(getEventLoopStats()).toBeUndefined();
	});
});

describe("shouldLogWorstBlock", () => {
	it("logs a new worst block above the floor", () => {
		expect(shouldLogWorstBlock(200, 0)).toBe(true);
	});

	it("does not log a block below the floor", () => {
		expect(shouldLogWorstBlock(40, 0)).toBe(false);
	});

	it("does not re-log a block within delta of the last logged max", () => {
		expect(shouldLogWorstBlock(210, 200)).toBe(false); // 210 ≤ 200+25
	});

	it("logs a clearly worse block beyond the delta", () => {
		expect(shouldLogWorstBlock(300, 200)).toBe(true); // 300 > 225
	});
});

describe("shouldLogLoopBlock (#1723: log every block over the floor, not just a new worst)", () => {
	it("logs a block above the floor even when it is far below a prior worst", () => {
		// This is the load-bearing #1723 case: shouldLogWorstBlock(5000, 15000)
		// would be false (5000 is nowhere near the 15000 high-water), so gating
		// the LOG on it — as pre-fix code did — silently drops this block. The
		// floor-only gate must still log it.
		expect(shouldLogLoopBlock(5000)).toBe(true);
		expect(shouldLogWorstBlock(5000, 15000)).toBe(false);
	});

	it("does not log a block below the floor", () => {
		expect(shouldLogLoopBlock(40)).toBe(false);
	});

	it("logs a block exactly at the floor", () => {
		expect(shouldLogLoopBlock(60)).toBe(true);
	});

	it("respects a custom floor", () => {
		expect(shouldLogLoopBlock(90, 100)).toBe(false);
		expect(shouldLogLoopBlock(110, 100)).toBe(true);
	});
});

describe("isSuspendSuspectedBlock (system-stall discrimination, #1122)", () => {
	it("flags a huge block the window's CPU cannot account for (sleep/paging)", () => {
		// 290s block, ~0.3s of CPU in the window → the process was frozen.
		expect(isSuspendSuspectedBlock(290179, 300)).toBe(true);
	});

	it("does not flag a large block backed by matching CPU (genuine CPU stall)", () => {
		// A real 30s synchronous burst burns ~30s of main-thread CPU.
		expect(isSuspendSuspectedBlock(30000, 30000)).toBe(false);
	});

	it("never flags blocks below the floor, even with low CPU (protects the real tier)", () => {
		// A genuine 10.6s I/O-bound block with little CPU must stay 'real'.
		expect(isSuspendSuspectedBlock(10595, 50)).toBe(false);
	});

	it("respects the CPU slop so a near-match is not flagged", () => {
		expect(isSuspendSuspectedBlock(25000, 24500)).toBe(false); // within 1s slop
		expect(isSuspendSuspectedBlock(25000, 20000)).toBe(true); // 5s unaccounted
	});
});

describe("resetEventLoopMonitor window re-baselining (#1122)", () => {
	it("resets the wall window so a fresh turn measures a much smaller elapsed span", async () => {
		startEventLoopMonitor(10);
		await settle(60);
		const before = getEventLoopStats()?.windowWallMs ?? 0;
		expect(before).toBeGreaterThanOrEqual(40);
		resetEventLoopMonitor();
		const after = getEventLoopStats()?.windowWallMs ?? Number.POSITIVE_INFINITY;
		// Relative, not an absolute bound: a GC pause between reset and read can
		// inflate the fresh window on a loaded CI box, so assert only that reset
		// cut it well below the pre-reset elapsed span.
		expect(after).toBeLessThan(before / 2);
	});
});

/**
 * #1980: `windowCpuMs` has sat beside every `loop_block` since #1122 and was
 * never read together with `durationMs`. Over a 23h window (1221 records),
 * nine of the sixteen genuine 5s+ blocks burned LESS CPU than the block
 * lasted — they were parked in a syscall, not computing — and every one of
 * them read as ordinary work because `suspectSystemStall` only fires above
 * 20s. These pin the ladder that splits them. Every case is a real row from
 * the issue's evidence where one exists.
 */
describe("classifyLoopBlock: CPU-vs-wall stall discrimination (#1980)", () => {
	it("declines to classify a sub-floor block instead of defaulting it to compute", () => {
		// Under STALL_CLASSIFY_FLOOR_MS the CPU accounting is the same order as
		// its own measurement slop, so the honest answer is "not classified".
		expect(classifyLoopBlock(900, 0).stallClass).toBe("below-floor");
	});

	it("classes a block the window's whole CPU budget cannot cover as a non-CPU stall", () => {
		// #1980's top row: d=19780ms cpu=7907ms at 13:59:03. 7.9s of CPU cannot
		// produce a 19.8s synchronous burst, so the loop was waiting.
		expect(classifyLoopBlock(19780, 7907).stallClass).toBe("non-cpu-stall");
		// Two more from the same evidence block.
		expect(classifyLoopBlock(16895, 4078).stallClass).toBe("non-cpu-stall");
		expect(classifyLoopBlock(10435, 1688).stallClass).toBe("non-cpu-stall");
	});

	it("classes a block the window's CPU covers as cpu-accounted, not a stall", () => {
		expect(classifyLoopBlock(5000, 5500).stallClass).toBe("cpu-accounted");
	});

	it("keeps the suspend verdict distinct from an ordinary non-CPU stall", () => {
		// At or above the 20s suspend floor with ~no CPU: sleep/standby/paging.
		expect(classifyLoopBlock(300000, 200).stallClass).toBe("system-stall");
		// The SAME evidence shape below that floor is the narrower class — this
		// is the whole 5-20s tier #1980 found and #1122's flag could not see.
		expect(classifyLoopBlock(15435, 3985).stallClass).toBe("non-cpu-stall");
	});

	it("agrees with the pre-existing suspend predicate on every classified sample", () => {
		// One definition of a suspend, not two: the class delegates.
		for (const [maxMs, cpuMs] of [
			[300000, 200],
			[25000, 20000],
			[30000, 30000],
			[19780, 7907],
			[5000, 5500],
		] as const) {
			expect(
				classifyLoopBlock(maxMs, cpuMs).stallClass === "system-stall",
			).toBe(isSuspendSuspectedBlock(maxMs, cpuMs));
		}
	});

	it("honours the CPU slop so a near-exact match is not called a stall", () => {
		expect(classifyLoopBlock(5000, 4800).stallClass).toBe("cpu-accounted");
		expect(classifyLoopBlock(5000, 4700).stallClass).toBe("non-cpu-stall");
	});

	it("reports the CPU coverage ratio the issue had to compute by hand", () => {
		expect(classifyLoopBlock(19780, 7907).cpuCoverageRatio).toBe(0.4);
		expect(classifyLoopBlock(5000, 5500).cpuCoverageRatio).toBe(1.1);
		// No block means nothing to cover — not a ratio of zero.
		expect(classifyLoopBlock(0, 0).cpuCoverageRatio).toBeUndefined();
	});

	it("getEventLoopStats carries the class and the ratio onto every sample", async () => {
		startEventLoopMonitor(10);
		await settle(40);
		const s = getEventLoopStats();
		// A live loop's own jitter is far under the floor, so the honest class is
		// below-floor — and it must be PRESENT, which is what the loop_block
		// record reads.
		expect(s?.stallClass).toBe("below-floor");
		expect(s?.suspectSystemStall).toBe(false);
		expect(
			s?.cpuCoverageRatio === undefined || Number.isFinite(s.cpuCoverageRatio),
		).toBe(true);
	});
});
