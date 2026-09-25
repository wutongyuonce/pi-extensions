import { describe, expect, it } from "vitest";
import {
	createDeadline,
	forEachCooperatively,
	yieldIfOverBudget,
} from "../../clients/cooperative-budget.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";

function busyWait(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		// Deliberately occupy the event loop to make the scheduling bound visible.
	}
}

describe("cooperative work budget (#1215)", () => {
	it("uses a resettable monotonic deadline", async () => {
		const deadline = createDeadline(0);
		expect(deadline.expired()).toBe(true);
		expect(await yieldIfOverBudget(deadline)).toBe(true);
	});

	it("bounds abort checks by the same budget as yields", async () => {
		let checks = 0;
		await expect(
			forEachCooperatively(
				Array.from({ length: 100 }, (_, i) => i),
				() => {},
				{
					budgetMs: 0,
					shouldContinue: () => ++checks < 3,
					abortMessage: "superseded",
				},
			),
		).rejects.toThrow("superseded");
		expect(checks).toBe(3);
	});

	it(
		"keeps a large workload's synchronous block near the time budget",
		{
			retry: 2,
			timeout: 30_000,
		},
		async () => {
			const items = Array.from({ length: 800 }, (_, i) => i);
			const maxSyncBlockMs = await measureMaxSyncBlockMs(() =>
				forEachCooperatively(items, () => busyWait(0.35), { budgetMs: 4 }),
			);

			// The budget is 4 ms; allow a small multiple for one in-flight unit and
			// scheduler variance, while still rejecting the old 100-item cadence.
			expect(maxSyncBlockMs).toBeLessThan(32);
		},
	);

	it(
		"aborts within one work unit of supersession, not at an iteration checkpoint",
		{
			retry: 2,
			timeout: 30_000,
		},
		async () => {
			const startedAt = performance.now();
			const abortAt = startedAt + 18;
			let processed = 0;

			await expect(
				forEachCooperatively(
					Array.from({ length: 800 }, (_, i) => i),
					() => {
						processed += 1;
						busyWait(0.5);
					},
					{
						budgetMs: 4,
						shouldContinue: () => performance.now() < abortAt,
						abortMessage: "superseded",
					},
				),
			).rejects.toThrow("superseded");

			// The per-unit supersession check bounds abort latency to one work unit;
			// a modulus-100 checkpoint regression processes the full checkpoint batch.
			expect(processed).toBeLessThan(40);
		},
	);
});
