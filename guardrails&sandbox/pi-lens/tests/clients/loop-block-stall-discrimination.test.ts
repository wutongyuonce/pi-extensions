/**
 * #1980 AC4, end to end on the REAL monitor: an injected synchronous stall
 * must classify as a stall, not as compute.
 *
 * The sibling cases in `event-loop-monitor.test.ts` drive the pure classifier
 * with numbers copied out of `latency.log`. That proves the ladder, but not
 * that the ladder is fed the right numbers: `getEventLoopStats` reads its
 * `windowCpuMs` from `process.cpuUsage()` and its `maxMs` from the native
 * histogram, and a fix that classifies correctly on paper is worthless if
 * those two are measured over spans that do not line up.
 *
 * So this file blocks the loop for real, twice, with the ONLY difference
 * being the CPU axis under test:
 *
 * - `Atomics.wait` on a `SharedArrayBuffer` parks the thread in a futex wait.
 *   The loop is genuinely blocked (nothing can be serviced) and ~no CPU is
 *   burned. That is the exact shape of #1980's nine records: sync fs on a
 *   cloud-backed tree, a blocking native call, `spawnSync`.
 * - A busy loop of the SAME duration blocks the loop for the same wall time
 *   while burning that time as CPU.
 *
 * Same monitor, same code path, same duration. If the classifier were fed a
 * CPU number that does not correspond to its window, both would land in the
 * same class and one of these two cases would fail.
 *
 * Lane: this file measures real CPU-vs-wall, so it runs in vitest.config.ts's
 * serialized "wall-clock-budget" project. Under the default fork storm a busy
 * spin can be descheduled — it would then burn far less CPU than the wall time
 * it held, and the compute case would read as a stall. That is contention, not
 * a regression, and the cure is a quiet host, not a looser assertion.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	_stopEventLoopMonitorForTest,
	getEventLoopStats,
	resetEventLoopMonitor,
	startEventLoopMonitor,
} from "../../clients/event-loop-monitor.js";

afterEach(() => {
	_stopEventLoopMonitorForTest();
});

const settle = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Comfortably over `STALL_CLASSIFY_FLOOR_MS` (1000), so both cases are
 * actually classified rather than landing in `below-floor`, and long enough
 * that the 250ms slop cannot swallow the difference between the two.
 */
const BLOCK_MS = 1600;

/**
 * Block the event loop WITHOUT burning CPU — a futex wait that no one ever
 * wakes, so it runs out its timeout. This is the production-faithful stand-in
 * for a blocking syscall: the thread is parked, the loop is dead, the CPU
 * counter does not move.
 */
function blockWithoutCpu(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Block the event loop by burning CPU for the same wall time. */
function blockWithCpu(ms: number): void {
	const until = Date.now() + ms;
	// Non-trivial arithmetic so the JIT cannot elide the loop body.
	let sink = 0;
	while (Date.now() < until) sink = (sink + 1) % 1_000_003;
	if (sink === -1) throw new Error("unreachable");
}

/**
 * Start a fresh window, run `block`, then read the sample it produced.
 *
 * The `settle` AFTER `resetEventLoopMonitor` is load-bearing, not padding.
 * Measured on Node v24.19.0: `IntervalHistogram.reset()` followed by a
 * synchronous block in the SAME tick records ~32ms for a 1600ms block, while
 * the identical block one tick later records 1601ms. Production is always the
 * second shape — `resetEventLoopMonitor` runs at `turn_end` and the next
 * turn's block is many ticks later — so blocking in the reset's own tick would
 * be the unfaithful harness, not the faithful one.
 */
async function sampleOneBlock(block: () => void) {
	startEventLoopMonitor(10);
	await settle(30); // let the histogram take a few clean baseline samples
	resetEventLoopMonitor(); // window starts HERE: wall, CPU, and histogram together
	await settle(30); // see above: the reset needs a tick before the block
	block();
	await settle(60); // let the delayed timer fire so the histogram records it
	const stats = getEventLoopStats();
	expect(stats).toBeDefined();
	return stats as NonNullable<typeof stats>;
}

describe("#1980 injected stalls classify by CPU, not by duration", () => {
	it("a real non-CPU block (parked thread) reads as non-cpu-stall", async () => {
		const stats = await sampleOneBlock(() => blockWithoutCpu(BLOCK_MS));

		// The block really happened and really was over the classify floor.
		expect(stats.maxMs).toBeGreaterThan(1000);
		// And it really burned no CPU — this is the axis under test, so assert it
		// rather than trust it.
		expect(stats.windowCpuMs).toBeLessThan(stats.maxMs / 2);
		// Pre-fix there is no such field at all; with only #1122's flag this
		// sample reads `suspectSystemStall: false`, i.e. indistinguishable from
		// ordinary work, which is the whole complaint in #1980.
		expect(stats.stallClass).toBe("non-cpu-stall");
		// Not a suspend: well under the 20s floor, and the old flag is unchanged.
		expect(stats.suspectSystemStall).toBe(false);
		expect(stats.cpuCoverageRatio).toBeLessThan(0.5);
	});

	it("a CPU spin of the same duration reads as cpu-accounted", async () => {
		const stats = await sampleOneBlock(() => blockWithCpu(BLOCK_MS));

		expect(stats.maxMs).toBeGreaterThan(1000);
		// The discriminator: this window's CPU covers its own block.
		expect(stats.windowCpuMs).toBeGreaterThan(stats.maxMs * 0.8);
		expect(stats.stallClass).toBe("cpu-accounted");
		expect(stats.suspectSystemStall).toBe(false);
	});

	it("the two blocks are the same length and differ only on the CPU axis", async () => {
		// Guards against a future change that "passes" both cases above by
		// keying on duration: if the classifier ever read `maxMs` alone, these
		// two comparable durations could not land in different classes.
		const stalled = await sampleOneBlock(() => blockWithoutCpu(BLOCK_MS));
		_stopEventLoopMonitorForTest();
		const spun = await sampleOneBlock(() => blockWithCpu(BLOCK_MS));

		expect(Math.abs(stalled.maxMs - spun.maxMs)).toBeLessThan(BLOCK_MS / 2);
		expect(stalled.stallClass).not.toBe(spun.stallClass);
	});
});
