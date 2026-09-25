import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CASCADE_NEIGHBOUR_BUDGET,
	cascadeSettleWaitMs,
	deriveCascadeNeighbourBudget,
} from "../../clients/cascade-budget.js";
import { _resetQuietWindowEnabledForTests } from "../../clients/quiet-window-config.js";

const ENV_KEYS = [
	"PI_LENS_CASCADE_SETTLE_WAIT_MS",
	"PI_LENS_CASCADE_NEIGHBOUR_COST_MS",
	"PI_LENS_CASCADE_NEIGHBOUR_FLOOR",
	"PI_LENS_QUIET_WINDOW_WAIT_MS",
	"PI_LENS_QUIET_WINDOW",
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
	// The kill switch is memoized on first read — clear it so a case that flips
	// PI_LENS_QUIET_WINDOW cannot leak its answer into the next one.
	_resetQuietWindowEnabledForTests();
});

describe("cascadeSettleWaitMs", () => {
	it("defaults to 5000 and accepts an explicit 0", () => {
		expect(cascadeSettleWaitMs()).toBe(5000);
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "0");
		expect(cascadeSettleWaitMs()).toBe(0);
	});

	it("falls back to the default for a non-numeric or negative value", () => {
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "soon");
		expect(cascadeSettleWaitMs()).toBe(5000);
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "-1");
		expect(cascadeSettleWaitMs()).toBe(5000);
	});
});

describe("deriveCascadeNeighbourBudget", () => {
	it("leaves the flat cap alone while the full walk still fits", () => {
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 0 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			ceiling: CASCADE_NEIGHBOUR_BUDGET,
			remainingMs: 5000,
			zone: "fits",
		});
		// The measured median cascade — 30 ms of prelude buys nothing back.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 30 }).budget).toBe(
			CASCADE_NEIGHBOUR_BUDGET,
		);
		// 1000 ms of prelude still affords 40 at 100 ms each: narrowing starts
		// only once the flat walk genuinely no longer fits.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 1000 })).toMatchObject({
			budget: 40,
			zone: "fits",
		});
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 1100 })).toMatchObject({
			budget: 39,
			zone: "narrowed",
		});
	});

	it("narrows in step with the on-time window left, inside the rescue band", () => {
		// The measured logger.ts prelude: a 2046 ms reverse-deps refresh.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 2046 })).toMatchObject({
			budget: 29,
			zone: "narrowed",
		});
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4000 })).toMatchObject({
			budget: 10,
			zone: "narrowed",
		});
		// The band's lower edge: 500 ms left still affords exactly the floor.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4500 })).toMatchObject({
			budget: 5,
			zone: "narrowed",
		});
	});

	it("keeps the FULL budget once the window is blown past rescue", () => {
		// One millisecond past the band: a floor-sized walk no longer fits
		// either, so narrowing would drop the tail for good AND still miss. The
		// carry-over (#1443) delivers the whole set one turn late instead.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4501 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			zone: "past-rescue",
		});
		// The cold-session case: a fresh graph build measured at ~19 s.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 19_000 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			remainingMs: -14_000,
			zone: "past-rescue",
		});
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 600_000 }).budget).toBe(
			CASCADE_NEIGHBOUR_BUDGET,
		);
	});

	it("stands down when the window could never fit a full walk anyway", () => {
		// A 1200 ms wait cannot fit 40 neighbours at 100 ms each even at zero
		// prelude, so there is no LATE run to rescue — only every run to shrink.
		// Narrowing here would be a budget change wearing a timeout's clothes.
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "1200");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 0 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			zone: "no-rescue-window",
		});
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 1100 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			zone: "no-rescue-window",
		});
	});

	it("keeps the full cap when the settle wait is disabled", () => {
		// wait 0 means turn_end never blocks on this run — it is carried to the
		// next turn either way, so there is no window to fit inside.
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "0");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 30_000 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			zone: "no-rescue-window",
		});
	});

	it("#1462 review F-E: an env override that disarms the rescue band names itself once, in the degradation ledger", async () => {
		// CASCADE_NEIGHBOUR_BUDGET is a module-level constant, frozen at import —
		// exercising an override means loading a FRESH module instance with the
		// env var already set, not mutating process.env after this file's static
		// top-level import already baked in the default.
		vi.resetModules();
		const previous = process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET;
		// 60 * 100ms/neighbour = 6000ms, past the 5000ms default settle window —
		// every cascade reads no-rescue-window. Nobody asked to disable the
		// rescue band; they asked for a bigger cap, and it disarmed silently.
		process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET = "60";
		try {
			const { resetDegradationLedger, getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");
			resetDegradationLedger();
			const freshBudget = await import("../../clients/cascade-budget.js");
			expect(freshBudget.CASCADE_NEIGHBOUR_BUDGET).toBe(60);

			const decision = freshBudget.deriveCascadeNeighbourBudget({
				elapsedMs: 0,
			});
			expect(decision.zone).toBe("no-rescue-window");

			const summary = getDegradationSummary();
			const group = summary.find(
				(g) => g.kind === "cascade-budget-override-disarmed",
			);
			expect(group).toBeDefined();
			expect(group?.latestReasons[0]?.reason).toContain("60");

			// Once per session — a second disarmed call must not double-log.
			freshBudget.deriveCascadeNeighbourBudget({ elapsedMs: 0 });
			expect(
				getDegradationSummary().find(
					(g) => g.kind === "cascade-budget-override-disarmed",
				)?.count,
			).toBe(1);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET;
			} else {
				process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET = previous;
			}
			vi.resetModules();
		}
	});

	it("records the pipeline's whole drain, not just the turn_end settle", () => {
		// The turn_end cap is NOT the only deadline: `cascade_carry_over_settle`
		// gives a still-pending compute another 15 s at agent_settled. That is
		// why the past-rescue zone can afford to stay wide, so it belongs on the
		// record rather than being invisible.
		expect(
			deriveCascadeNeighbourBudget({ elapsedMs: 0 }).deliveryWindowMs,
		).toBe(20_000);
		setEnv("PI_LENS_QUIET_WINDOW_WAIT_MS", "3000");
		expect(
			deriveCascadeNeighbourBudget({ elapsedMs: 0 }).deliveryWindowMs,
		).toBe(8000);
	});

	it("does not count a drain that PI_LENS_QUIET_WINDOW=0 has switched off", () => {
		// `quietWindowWaitMs()` keeps returning 15000 when the scheduler is
		// disabled — it is the task budget, not a statement that the task runs.
		// A field documented as the whole deadline stack must not claim a second
		// window that no longer exists, or the past-rescue zone looks justified
		// by 15 s of drain that is never going to happen.
		setEnv("PI_LENS_QUIET_WINDOW", "0");
		_resetQuietWindowEnabledForTests();
		expect(
			deriveCascadeNeighbourBudget({ elapsedMs: 0 }).deliveryWindowMs,
		).toBe(5000);
	});

	it("clamps a floor set above the ceiling down to the ceiling", () => {
		// A floor over the cap would make the derived budget LARGER than the flat
		// one it exists to bound.
		expect(
			deriveCascadeNeighbourBudget({
				elapsedMs: 2000,
				settleWaitMs: 5000,
				ceiling: 8,
				floor: 40,
				perNeighbourMs: 100,
			}).budget,
		).toBe(8);
	});

	it("treats a non-finite or negative elapsed as no time spent", () => {
		expect(
			deriveCascadeNeighbourBudget({ elapsedMs: Number.NaN }),
		).toMatchObject({ budget: CASCADE_NEIGHBOUR_BUDGET, zone: "fits" });
		expect(deriveCascadeNeighbourBudget({ elapsedMs: -1000 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			zone: "fits",
		});
	});

	it("honours the per-neighbour cost and floor overrides from env", () => {
		// A 500 ms cost puts a full walk at 20 s, well over the 5 s window, so
		// the derivation stands down rather than shrinking every cascade to 10.
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_COST_MS", "500");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 0 })).toMatchObject({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			zone: "no-rescue-window",
		});
		// A 50 ms cost fits a full walk in 2 s, so the band opens at 3 s of
		// prelude and a raised floor holds the bottom of it.
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_COST_MS", "50");
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_FLOOR", "12");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4400 })).toMatchObject({
			budget: 12,
			zone: "narrowed",
		});
	});

	it("falls back to the default cost when the env knob is unusable", () => {
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_COST_MS", "0");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4000 }).budget).toBe(10);
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_COST_MS", "fast");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4000 }).budget).toBe(10);
	});
});
