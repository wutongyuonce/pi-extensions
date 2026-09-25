/**
 * Shared performance-test harness (#192).
 *
 * Two primitives the perf guards need:
 *   - `generateSourceTree` — a realistic, scaled source fixture (nested dirs, a
 *     `.gitignore` + `.git` marker, shadowed-`.js` build artifacts, and
 *     `node_modules` noise) so walkers are exercised at the size where O(N)
 *     bursts actually bite (~2k files), not at pi-lens's ~300.
 *   - `measureMaxSyncBlockMs` — **event-loop occupancy**, not wall-clock
 *     duration. It runs an independent self-rescheduling sampler while the work
 *     runs and returns the longest gap between successive sampler ticks = the
 *     longest synchronous stretch the work held the loop. Unlike wrapping the
 *     code's own `setImmediate`, this catches a *fully non-yielding* function
 *     (the catastrophic case): if the work blocks synchronously, the sampler
 *     can't fire until it finishes, so that whole block shows up as one gap.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { vi } from "vitest";

/**
 * Build a nested tree of ~`target` source files under `root`, plus ignored
 * noise (a `node_modules/` dir) and shadowed `.js` build artifacts next to
 * `.ts` files. Writes a `.gitignore` + empty `.git` marker so the ignore root
 * resolves to `root`. Returns the number of source files created.
 */
export function generateSourceTree(root: string, target: number): number {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(
		path.join(root, ".gitignore"),
		"node_modules/\ndist/\n*.log\nbuild/\n",
	);
	fs.writeFileSync(path.join(root, ".git"), "");
	const exts = [".ts", ".ts", ".js", ".py", ".tsx"];
	let made = 0;
	const mk = (dir: string, depth: number): void => {
		fs.mkdirSync(dir, { recursive: true });
		const here = depth >= 2 ? 6 : 3;
		for (let i = 0; i < here && made < target; i++) {
			const ext = exts[made % exts.length];
			fs.writeFileSync(
				path.join(dir, `file${i}${ext}`),
				`export const x${i} = ${i};\n`,
			);
			made++;
			// A shadowed .js next to a .ts must be filtered as a build artifact.
			if (ext === ".ts" && i % 2 === 0) {
				fs.writeFileSync(path.join(dir, `file${i}.js`), `var x=${i};`);
			}
		}
		if (depth < 5 && made < target) {
			for (let d = 0; d < 3 && made < target; d++) {
				mk(path.join(dir, `sub${d}`), depth + 1);
			}
		}
	};
	mk(path.join(root, "src"), 0);
	mk(path.join(root, "lib"), 0);
	const nm = path.join(root, "node_modules", "pkg");
	fs.mkdirSync(nm, { recursive: true });
	for (let i = 0; i < 50; i++) {
		fs.writeFileSync(path.join(nm, `m${i}.js`), "module.exports=1");
	}
	return made;
}

/**
 * Run `work` and return the longest synchronous stretch (ms) it held the event
 * loop — i.e. the max gap between ticks of an independent sampler. A value near
 * `work`'s total runtime means it never yielded; a small value means it yielded
 * frequently. This is the regression signal for "blocks the TUI", which raw
 * duration cannot distinguish from harmless async/subprocess time.
 */
export async function measureMaxSyncBlockMs(
	work: () => Promise<unknown>,
): Promise<number> {
	let maxLagMs = 0;
	let running = true;
	let last = process.hrtime.bigint();
	const tick = (): void => {
		const now = process.hrtime.bigint();
		const lagMs = Number(now - last) / 1e6;
		if (lagMs > maxLagMs) maxLagMs = lagMs;
		last = now;
		if (running) setImmediate(tick);
	};
	last = process.hrtime.bigint();
	setImmediate(tick);
	try {
		await work();
	} finally {
		running = false;
	}
	// Let the final gap (the stretch after the work's last yield) register.
	await new Promise<void>((resolve) => setImmediate(resolve));
	return maxLagMs;
}

/**
 * Run `work` and return how many times it read the clock (`performance.now`).
 *
 * A deterministic WORK COUNT, not a wall-clock measurement, so it is invariant
 * to machine speed and event-loop load (#2202, #2254). A cooperative loop that
 * checks its deadline per bounded work unit reads the clock O(work units) times;
 * a loop that checks per posting element reads it O(elements) times. The gap
 * between those two is what a clock-read guard pins, and it does not move when a
 * shared runner lane is under contention, so this belongs outside the
 * timing-sensitive lane.
 */
export async function countClockReads(
	work: () => Promise<unknown>,
): Promise<number> {
	const spy = vi.spyOn(performance, "now");
	try {
		await work();
		return spy.mock.calls.length;
	} finally {
		spy.mockRestore();
	}
}
