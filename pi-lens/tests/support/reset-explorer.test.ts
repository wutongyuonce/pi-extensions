import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	reserveManagedToolRefreshSlot,
	resetManagedToolRefreshSession,
} from "../../clients/installer/managed-tool-refresh-session.js";
import { exploreInterleavings, type Tap } from "./reset-explorer.js";

/** A path with `n` tap points that always succeeds and records each reset. */
function makePath(n: number, onRun: (resetsSeenThisRun: number) => void) {
	let resetsThisRun = 0;
	const reset = () => {
		resetsThisRun += 1;
	};
	const run = async (tap: Tap) => {
		resetsThisRun = 0;
		for (let i = 0; i < n; i += 1) {
			await tap();
		}
		onRun(resetsThisRun);
		return resetsThisRun;
	};
	return { run, reset };
}

describe("exploreInterleavings", () => {
	it("runs the baseline pass plus one pass per tap point", async () => {
		const { run, reset } = makePath(3, () => {});
		const invariant = vi.fn();

		const outcome = await exploreInterleavings({
			run,
			reset,
			invariant,
		});

		expect(outcome).toEqual({ tapPointCount: 3, executions: 4 });
		// Baseline (tapIndex: null) + one pass per tap point (0, 1, 2).
		expect(invariant.mock.calls.map((c) => c[0].tapIndex)).toEqual([
			null,
			0,
			1,
			2,
		]);
	});

	it("fires the reset exactly once per targeted pass, at the targeted tap", async () => {
		// Mutation-proof: an explorer that fires zero resets, or fires every
		// reset at tap 0 regardless of target, must fail this.
		const resetCallsPerRun: number[] = [];
		const { run, reset } = makePath(4, (n) => resetCallsPerRun.push(n));

		await exploreInterleavings({ run, reset, invariant: () => {} });

		// Baseline run: no reset. Then one reset each for taps 0..3.
		expect(resetCallsPerRun).toEqual([0, 1, 1, 1, 1]);
	});

	it("checks the invariant against the baseline pass with no reset fired", async () => {
		// Mutation-proof: if the explorer skipped the baseline pass, this would
		// never see tapIndex === null, or would see it fire a reset.
		let baselineSawReset = false;
		const { run, reset } = makePath(2, () => {});
		let sawBaseline = false;

		await exploreInterleavings({
			run,
			reset: () => {
				reset();
				if (!sawBaseline) baselineSawReset = true;
			},
			invariant: ({ tapIndex }) => {
				if (tapIndex === null) sawBaseline = true;
			},
		});

		expect(sawBaseline).toBe(true);
		expect(baselineSawReset).toBe(false);
	});

	it("visits the LAST tap point, not just every point before it", async () => {
		// The mutation-proof case for "skips await points": a loop bound of
		// `target < tapPointCount - 1` (an off-by-one that silently drops the
		// final point) would make this list stop at 1 instead of reaching 2,
		// and this test would fail.
		const { run, reset } = makePath(3, () => {});
		const seenTapIndexes: Array<number | null> = [];

		await exploreInterleavings({
			run,
			reset,
			invariant: ({ tapIndex }) => {
				seenTapIndexes.push(tapIndex);
			},
		});

		expect(seenTapIndexes).toEqual([null, 0, 1, 2]);
	});

	it("propagates an invariant failure at the exact tap index that violated it", async () => {
		const { run, reset } = makePath(3, () => {});

		await expect(
			exploreInterleavings({
				run,
				reset,
				invariant: ({ tapIndex }) => {
					if (tapIndex === 1) throw new Error("boom at tap 1");
				},
			}),
		).rejects.toThrow("boom at tap 1");
	});

	it("passes the path's thrown error to the invariant instead of swallowing it", async () => {
		const run = async (tap: Tap) => {
			await tap();
			throw new Error("path failed");
		};
		const seen: unknown[] = [];

		await exploreInterleavings({
			run,
			reset: () => {},
			invariant: ({ error }) => {
				seen.push(error);
			},
		});

		expect(seen).toHaveLength(2); // baseline + the one tap point
		for (const err of seen) {
			expect((err as Error).message).toBe("path failed");
		}
	});

	it("does nothing further when the path exposes zero tap points", async () => {
		const run = async () => "no taps here";
		const invariant = vi.fn();

		const outcome = await exploreInterleavings({
			run,
			reset: () => {
				throw new Error("reset must never fire with zero tap points");
			},
			invariant,
		});

		expect(outcome).toEqual({ tapPointCount: 0, executions: 1 });
		expect(invariant).toHaveBeenCalledTimes(1);
		expect(invariant.mock.calls[0][0].tapIndex).toBeNull();
	});

	it("refuses to run a path whose tap count exceeds maxTapPoints", async () => {
		const { run, reset } = makePath(5, () => {});

		await expect(
			exploreInterleavings({
				run,
				reset,
				invariant: () => {},
				maxTapPoints: 4,
			}),
		).rejects.toThrow(/exposed 5 tap points.*maxTapPoints cap of 4/s);
	});

	it("throws when the path's tap sequence is nondeterministic across runs", async () => {
		// A path whose await count depends on external state (unmocked timers,
		// real IO) breaks the explorer's addressing scheme. It must fail loudly
		// rather than silently miss a tap point.
		let call = 0;
		const run = async (tap: Tap) => {
			call += 1;
			const n = call === 1 ? 3 : 1; // baseline sees 3, every other run sees 1
			for (let i = 0; i < n; i += 1) await tap();
		};

		await expect(
			exploreInterleavings({ run, reset: () => {}, invariant: () => {} }),
		).rejects.toThrow(/tap point 1 was never reached/);
	});
});

/**
 * The explorer must be able to REDISCOVER a known bug on the known-bad code
 * shape, or it proves nothing about its own hunting power (mutation-proofing
 * one level up: the explorer's own tests must fail if it never actually
 * finds anything).
 *
 * This reconstructs the #1746 review-round-2 R2-F1 walk shape from the
 * merged fix's own commit message (`ca879232`, "fix(installer): bound the
 * refresh walk to a local allowance"): a loop that re-checked
 * `reserveManagedToolRefreshSlot` PER TOOL, against the real (unmodified)
 * `managed-tool-refresh-session.ts` primitives. `handleSessionStart` zeroing
 * that session counter mid-walk let a long update plus a few session starts
 * walk the whole stale list. The real fix moved to a local allowance
 * captured once, which `tests/clients/installer/managed-tool-refresh.test.ts`'s
 * "reset-interleaving explorer (#1840)" block exercises against the current,
 * fixed `executeManagedToolRefresh`.
 */
describe("rediscovers a known bug on its pre-fix shape (#1746 R2-F1)", () => {
	beforeEach(() => {
		resetManagedToolRefreshSession();
	});

	afterEach(() => {
		resetManagedToolRefreshSession();
	});

	/** The walk shape BEFORE ca879232: re-checks the budget per tool. */
	async function buggyWalk(tap: Tap): Promise<{ spawns: number }> {
		if (!reserveManagedToolRefreshSlot(1)) return { spawns: 0 };
		let reserved = 1;
		let spawns = 0;
		const staleTools = ["knip", "pyright", "oxlint"];
		for (const _tool of staleTools) {
			if (reserved > 0) {
				reserved -= 1;
			} else if (!reserveManagedToolRefreshSlot(1)) {
				break;
			}
			spawns += 1; // stands in for the awaited `npm update` spawn
			await tap();
		}
		return { spawns };
	}

	it("finds the walk-extension bug: a mid-run reset must not buy the loop another tool", async () => {
		await expect(
			exploreInterleavings({
				run: (tap) => {
					resetManagedToolRefreshSession();
					return buggyWalk(tap);
				},
				reset: () => resetManagedToolRefreshSession(),
				invariant: ({ result }) => {
					expect(result?.spawns).toBeLessThanOrEqual(1);
				},
			}),
		).rejects.toThrow(); // expect() inside invariant throws on violation
	});

	it("confirms the FIXED shape (local allowance) holds under the same exploration", async () => {
		async function fixedWalk(tap: Tap): Promise<{ spawns: number }> {
			if (!reserveManagedToolRefreshSlot(1)) return { spawns: 0 };
			let held = 1;
			let allowance = held;
			let spawns = 0;
			const staleTools = ["knip", "pyright", "oxlint"];
			for (const _tool of staleTools) {
				if (allowance <= 0) break;
				allowance -= 1;
				held -= 1;
				spawns += 1;
				await tap();
			}
			return { spawns };
		}

		const outcome = await exploreInterleavings({
			run: (tap) => {
				resetManagedToolRefreshSession();
				return fixedWalk(tap);
			},
			reset: () => resetManagedToolRefreshSession(),
			invariant: ({ result }) => {
				expect(result?.spawns).toBeLessThanOrEqual(1);
			},
		});

		// The local allowance caps the walk at 1 spawn (the session budget),
		// so there is exactly 1 tap point to explore — unlike the buggy shape
		// above, which walked all 3 once a reset landed mid-run.
		expect(outcome.tapPointCount).toBe(1);
	});
});
