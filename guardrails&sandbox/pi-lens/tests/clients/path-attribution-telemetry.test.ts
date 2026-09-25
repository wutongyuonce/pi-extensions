import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";
import { _resetProcessSingletonsForTests } from "../../clients/process-singletons.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
// #2281 shape: a partial importActual mock, not a bare factory replacement —
// the rest of the real module's export surface stays intact, so an export
// added later cannot be silently hidden by this mock.
vi.mock("../../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
	};
});

import {
	emitVerifiedPathAttributionRollup,
	getVerifiedPathAttributionGuessCount,
	recordVerifiedPathAttributionGuess,
	resetVerifiedPathAttributionGuessCount,
} from "../../clients/path-attribution-telemetry.js";

describe("path-attribution telemetry", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		_resetProcessSingletonsForTests();
	});

	it("counts verified guesses and sums them in one bounded rollup at session end", () => {
		recordVerifiedPathAttributionGuess();
		recordVerifiedPathAttributionGuess();
		expect(getVerifiedPathAttributionGuessCount()).toBe(2);
		latencyEntries.length = 0;
		emitVerifiedPathAttributionRollup("/project");
		expect(latencyEntries).toEqual([
			{
				type: "phase",
				phase: "path_attribution_verified_rollup",
				filePath: "/project",
				durationMs: 0,
				metadata: { count: 2 },
			},
		]);
		expect(getVerifiedPathAttributionGuessCount()).toBe(0);
	});

	it("resets the tally without emitting", () => {
		recordVerifiedPathAttributionGuess();
		resetVerifiedPathAttributionGuessCount();
		expect(getVerifiedPathAttributionGuessCount()).toBe(0);
	});

	it("emits nothing when the session recorded no verified guesses", () => {
		emitVerifiedPathAttributionRollup("/project");
		expect(latencyEntries).toEqual([]);
	});
});

// #2319: the tally is process-singleton backed now (AGENTS.md catalog shape
// 25) — the same decision #2249 made for its bind rollup. This describe uses
// shape 25's detection method: evaluate the module TWICE (vi.resetModules +
// dynamic import) and prove the second evaluation sees the first's count. pi
// evaluates the module graph more than once per process (#2146 measured nine
// evaluations for one pid), so a module-scope `let` would silently undercount.
// Every import uses the `.js` specifier — the artifact the runtime loads
// (catalog shape 14) — never `.ts`.
describe("path-attribution telemetry — survives module re-evaluation (#2319)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		_resetProcessSingletonsForTests();
	});

	afterEach(() => {
		_resetProcessSingletonsForTests();
	});

	async function freshEvaluation() {
		vi.resetModules();
		return (await import("../../clients/path-attribution-telemetry.js")) as typeof import("../../clients/path-attribution-telemetry.js");
	}

	it("a second evaluation's guess is counted in the tally the first evaluation emits", async () => {
		const first = await freshEvaluation();
		first.recordVerifiedPathAttributionGuess();

		// pi's SECOND evaluation of the same graph — a fresh module instance,
		// same process, same globalThis. A module-scope `let` would start this
		// copy at zero and lose the first evaluation's guess.
		const second = await freshEvaluation();
		second.recordVerifiedPathAttributionGuess();

		expect(second.getVerifiedPathAttributionGuessCount()).toBe(2);

		latencyEntries.length = 0;
		second.emitVerifiedPathAttributionRollup("/project");

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				phase: "path_attribution_verified_rollup",
				filePath: "/project",
				durationMs: 0,
				metadata: { count: 2 },
			},
		]);
	});
});
