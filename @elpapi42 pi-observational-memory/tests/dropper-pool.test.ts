import { describe, expect, it } from "vitest";

import { observationPoolMetrics } from "../src/agents/dropper/pool.js";
import { foldLedger } from "../src/session-ledger/index.js";
import { observation, observationsDroppedEntry, observationsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

describe("V3 dropper active observation pool metrics", () => {
	it("reports below-target pools as not ready", () => {
		const observations = [observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 20 })];

		expect(observationPoolMetrics(observations, 100)).toMatchObject({
			observationTokens: 20,
			targetTokens: 100,
			tokensOverTarget: 0,
			fullness: 0.2,
			activeObservationCount: 1,
			droppableCount: 1,
			overTarget: false,
			ready: false,
		});
	});

	it("reports at-target pools as not ready", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 50 }),
			observation("bbbbbbbbbbbb", { relevance: "medium", tokenCount: 50 }),
		];

		const metrics = observationPoolMetrics(observations, 100);

		expect(metrics.observationTokens).toBe(100);
		expect(metrics.fullness).toBe(1);
		expect(metrics.tokensOverTarget).toBe(0);
		expect(metrics.maxDropsAllowed).toBe(0);
		expect(metrics.overTarget).toBe(false);
		expect(metrics.ready).toBe(false);
	});

	it("reports above-target pools as ready with target-return max drops", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 50 }),
			observation("bbbbbbbbbbbb", { relevance: "medium", tokenCount: 50 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 50 }),
		];

		const metrics = observationPoolMetrics(observations, 100);

		expect(metrics.observationTokens).toBe(150);
		expect(metrics.tokensOverTarget).toBe(50);
		expect(metrics.activeObservationCount).toBe(3);
		expect(metrics.droppableCount).toBe(3);
		expect(metrics.maxDropsAllowed).toBe(1);
		expect(metrics.overTarget).toBe(true);
		expect(metrics.ready).toBe(true);
	});

	it("clamps target-return max drops to active observation count", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 1 }),
			observation("bbbbbbbbbbbb", { relevance: "critical", tokenCount: 1 }),
		];

		const metrics = observationPoolMetrics(observations, 0);

		expect(metrics.tokensOverTarget).toBe(2);
		expect(metrics.maxDropsAllowed).toBe(2);
		expect(metrics.ready).toBe(true);
	});

	it("uses folded active observations so tombstones reduce readiness", () => {
		const dropped = observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 100 });
		const active = observation("bbbbbbbbbbbb", { relevance: "low", tokenCount: 20 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [dropped, active], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries as any);
		const metrics = observationPoolMetrics(folded.activeObservations, 100);

		expect(folded.activeObservations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(metrics.observationTokens).toBe(20);
		expect(metrics.overTarget).toBe(false);
		expect(metrics.ready).toBe(false);
	});
});
