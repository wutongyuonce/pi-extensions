/**
 * #1782: the session clock the workspace-diagnostics cache measures entry age
 * against, in a module of its own.
 *
 * It lives here rather than in `workspace-diagnostics-cache.ts` for one
 * measured reason (#1786 review F5): `handleSessionStart` must re-arm it, and
 * importing the cache module to do so drags `reverse-deps.ts`,
 * `blocker-freshness.ts`, and the generation-guard machinery into the EAGER
 * session-start module graph — 17 ms, about 9% of cold session start. This file
 * imports nothing, so the re-arm stays a plain synchronous call with no await
 * inserted into the middle of the reset sequence and no import cost.
 *
 * The default is module-import time so the very first sweep in a cold extension
 * host already treats every entry written by a PREVIOUS process as pre-session
 * (fail-closed). It must still be re-armed per session: a pi extension host
 * survives `session_start`, so a process-lifetime value would pin the first
 * session's clock for the life of the process (AGENTS.md's
 * session-signal-vs-latch screen). Registered in
 * `tests/support/session-state-registry.ts`, whose conformance suite proves the
 * reset is reachable from `handleSessionStart`.
 */

let _sessionStartedAt = Date.now();

/** Re-arm the session clock. Called by `handleSessionStart`. */
export function resetWorkspaceDiagnosticsCacheSession(
	startedAt: number = Date.now(),
): void {
	_sessionStartedAt = startedAt;
}

/** When the current session started, for entry-age comparisons. */
export function workspaceDiagnosticsCacheSessionStart(): number {
	return _sessionStartedAt;
}
