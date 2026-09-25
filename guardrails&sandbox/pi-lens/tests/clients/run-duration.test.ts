import { describe, expect, it } from "vitest";
import {
	formatRunDurationMs,
	isMeasuredDuration,
	toMeasuredDurationMs,
} from "../../clients/run-duration.js";

// #1479/#1480: `TestResult.duration` is absent when the run was not measured
// and present — 0 included — when it was. These pin that contract, because
// three surfaces (the turn-end log, `formatResult`, and every runner probe)
// read it from here.
describe("test duration reporting (#1479)", () => {
	it("renders a measured duration in ms", () => {
		expect(formatRunDurationMs(253)).toBe("253ms");
		expect(formatRunDurationMs(1)).toBe("1ms");
	});

	it("renders an absent duration as words, never as 0ms", () => {
		expect(formatRunDurationMs(undefined)).toBe("unmeasured");
		expect(formatRunDurationMs(null)).toBe("unmeasured");
	});

	// THE regression pin for this module. Under the old 0-as-sentinel
	// representation the predicate was `duration > 0`, and porting it onto the
	// optional field unchanged silently reinstates the bug #1479 fixed: pytest
	// prints `in 0.00s`, vstest prints `< 1 ms`, and a suite whose startTime
	// equals its endTime really did run in under a millisecond. All three are
	// measurements. If this test ever reads `unmeasured`, the predicate has
	// been tightened back to `> 0`.
	it("treats a measured zero as a measurement, not as an absent value", () => {
		expect(isMeasuredDuration(0)).toBe(true);
		expect(formatRunDurationMs(0)).toBe("0ms");
		expect(toMeasuredDurationMs(0)).toBe(0);
	});

	it("renders a garbled duration as unmeasured rather than a wrong number", () => {
		expect(formatRunDurationMs(-1)).toBe("unmeasured");
		expect(formatRunDurationMs(Number.NaN)).toBe("unmeasured");
		expect(formatRunDurationMs(Number.POSITIVE_INFINITY)).toBe("unmeasured");
	});

	it("rounds a fractional duration to whole milliseconds", () => {
		expect(formatRunDurationMs(40.6)).toBe("41ms");
		// Rounds, does not truncate: 40.6 is nearer 41ms.
		expect(toMeasuredDurationMs(40.6)).toBe(41);
		expect(toMeasuredDurationMs(40.4)).toBe(40);
	});

	it("collapses every non-measurement to absent", () => {
		expect(toMeasuredDurationMs(-7)).toBeUndefined();
		expect(toMeasuredDurationMs(Number.NaN)).toBeUndefined();
		expect(toMeasuredDurationMs(Number.POSITIVE_INFINITY)).toBeUndefined();
	});

	it("agrees with the predicate the formatters branch on", () => {
		expect(isMeasuredDuration(0.5)).toBe(true);
		expect(isMeasuredDuration(undefined)).toBe(false);
		expect(isMeasuredDuration(Number.NaN)).toBe(false);
	});
});
