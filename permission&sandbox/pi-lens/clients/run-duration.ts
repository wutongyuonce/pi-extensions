/**
 * #1479/#1480: one place decides whether a test run was actually timed, and
 * one place renders the answer.
 *
 * `TestResult.duration` is optional, and the two states are different facts.
 * A present number is a MEASUREMENT — including `0`, because pytest really
 * does print `in 0.00s` and a suite whose `startTime` equals its `endTime`
 * really did run in under a millisecond. An absent value means no
 * runner-reported figure was found at all.
 *
 * That contract was written down once, in the doc comment on
 * `TestResult.duration`, and then re-derived at every site that reads or
 * produces a duration. A reader of any one of those sites cannot see the
 * contract, and a producer that reaches for `0` when it means "did not
 * measure" reintroduces exactly the defect #1479 removed. These three
 * functions are the contract in executable form: `isMeasuredDuration`
 * classifies, `toMeasuredDurationMs` normalises a freshly parsed figure into
 * it, and `formatRunDurationMs` renders it.
 *
 * NOTE FOR ANYONE EDITING `isMeasuredDuration`: the predicate is `>= 0`, not
 * `> 0`. A measured zero is real. `> 0` looks like a harmless tightening and
 * is the single change that would silently restore the bug.
 *
 * Kept in its own module rather than exported from `test-runner-client.ts`:
 * `runtime-turn.ts` needs it on the hot turn-end path, and the client is
 * deliberately loaded lazily (`bootstrap.ts` dynamic-imports it), so a value
 * import from there would drag the whole runner into startup.
 */

/**
 * True only for a value that represents a real measurement.
 *
 * `0` is measured. `undefined`, `null`, `NaN`, the infinities, and a negative
 * figure are not: the last three can only come from a garbled parse, and a
 * garbled parse must degrade to "we did not measure this", never to a wrong
 * number.
 */
export function isMeasuredDuration(
	duration: number | null | undefined,
): duration is number {
	return (
		typeof duration === "number" && Number.isFinite(duration) && duration >= 0
	);
}

/**
 * Normalise a parsed elapsed time to the `TestResult.duration` contract.
 *
 * Returns whole milliseconds for a real reading — `0` included — and
 * `undefined` for anything that is not one, so a producer never has to spell
 * out the absent case itself.
 */
export function toMeasuredDurationMs(duration: number): number | undefined {
	return isMeasuredDuration(duration) ? Math.round(duration) : undefined;
}

/** Render a duration for a log line: `123ms`, or `unmeasured` when absent. */
export function formatRunDurationMs(
	duration: number | null | undefined,
): string {
	return isMeasuredDuration(duration)
		? `${Math.round(duration)}ms`
		: "unmeasured";
}
