/**
 * The two spawn results a `maxOutputBytes` cap can actually produce (#2100).
 *
 * `safe-spawn.ts` records `killedForOutputCap` when the cap starts ending the
 * child. POSIX commonly reports that as SIGTERM. Windows reports status 1 with
 * no failure or signal. A fast tool can still finish before the cap kill lands.
 * The live cross-platform invariants are pinned in
 * `tests/clients/safe-spawn-ambient-signal.test.ts`.
 */

import {
	SpawnFailureError,
	type SpawnResult,
} from "../../clients/safe-spawn.js";

/** The cap hit, safe-spawn killed the tree, and POSIX reported SIGTERM. */
export function capKilledSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	const cause = new Error("Process killed by signal: SIGTERM");
	return {
		stdout: "",
		stderr: "",
		status: null,
		signal: "SIGTERM",
		error: cause,
		failure: "signal",
		spawnFailure: new SpawnFailureError("killed", cause.message, cause),
		outputTruncated: true,
		killedForOutputCap: true,
		...overrides,
	};
}

/** The cap hit, safe-spawn killed the tree, and Windows reported status 1. */
export function capKilledOnWindowsSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	return {
		stdout: "",
		stderr: "",
		status: 1,
		outputTruncated: true,
		killedForOutputCap: true,
		...overrides,
	};
}

/** The cap hit, but the tool exited on its own before the SIGTERM landed. */
export function capFastExitSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	return {
		stdout: "",
		stderr: "",
		status: 0,
		outputTruncated: true,
		...overrides,
	};
}

/**
 * The cap hit AND the run then timed out — `outputTruncated` rides along under
 * a timeout failure, so a truncation guard must not claim this one.
 */
export function capThenTimedOutSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	const cause = new Error("Process timed out after 30000ms");
	return {
		stdout: "",
		stderr: "",
		status: null,
		error: cause,
		failure: "timeout",
		signal: "SIGTERM",
		spawnFailure: new SpawnFailureError("timeout", cause.message, cause),
		outputTruncated: true,
		killedForOutputCap: true,
		...overrides,
	};
}

/** The cap hit AND the run was then aborted. Same rule as the timeout shape. */
export function capThenAbortedSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	const cause = new Error("Spawn aborted");
	return {
		stdout: "",
		stderr: "",
		status: null,
		error: cause,
		failure: "aborted",
		signal: "SIGTERM",
		spawnFailure: new SpawnFailureError("killed", cause.message, cause),
		outputTruncated: true,
		killedForOutputCap: true,
		...overrides,
	};
}
