/**
 * The one reading of `SpawnResult.outputTruncated` (#2100).
 *
 * Its own module for the same reason `ledger-bounds.ts` is: `spawn-outcome.ts`
 * is on the shared runner path that dozens of test files reach with a bare
 * `vi.mock("safe-spawn.js")`, and importing a VALUE from safe-spawn there makes
 * every one of those mocks have to re-export it. This module has no imports, so
 * nobody has to mock it.
 */

/**
 * True when `outputTruncated` is the OUTPUT CAP's own verdict about this run,
 * and not a detail of some other ending.
 *
 * A timeout or an abort can carry `outputTruncated` too. Those endings own
 * their own classification, so they are excluded here rather than reported as
 * truncation.
 *
 * Typed structurally so `SpawnResult` and runner-level result shapes that
 * re-spell `failure` can both use it.
 */
export function truncatedByOutputCap(result: {
	outputTruncated?: boolean;
	failure?: string;
}): boolean {
	return (
		result.outputTruncated === true &&
		result.failure !== "timeout" &&
		result.failure !== "aborted"
	);
}

/**
 * True when `stopForOutputLimit` started terminating the child.
 *
 * Windows reports that termination as status 1 without a signal or failure,
 * while POSIX commonly reports SIGTERM. This field avoids reconstructing our
 * action from either platform's exit shape.
 */
export function killedForOutputCap(result: {
	killedForOutputCap?: boolean;
	failure?: string;
}): boolean {
	return (
		result.killedForOutputCap === true &&
		result.failure !== "timeout" &&
		result.failure !== "aborted"
	);
}
