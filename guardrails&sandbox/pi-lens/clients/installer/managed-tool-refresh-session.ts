/**
 * Per-session budget for the managed-tool version refresh (#1730).
 *
 * Deliberately its own module, with no imports. `runtime-session.ts` has to
 * call `resetManagedToolRefreshSession` from `handleSessionStart` — the seam
 * the session-state conformance suite walks — and importing
 * `managed-tool-refresh.ts` for it would drag the 4k-line installer registry
 * onto the `session_start` path. The refresh module itself is loaded lazily,
 * 30 seconds later, by the background timer that actually needs it.
 *
 * The counter is what stops one session from spawning 22 `npm update` calls.
 * It is NOT the cooldown: the real cadence lives in the persisted per-tool
 * stamp, so a process that restarts between every refresh still refreshes each
 * tool at most once a week. Resetting this counter only restores the session's
 * right to ASK.
 */

let refreshesThisSession = 0;

/** Refresh slots taken in the current session, successful or not. */
export function managedToolRefreshesThisSession(): number {
	return refreshesThisSession;
}

/**
 * Take one refresh slot if the session still has one, and say whether it did.
 *
 * Check-and-take in ONE synchronous call, deliberately (#1746 review F1). The
 * first cut read the remaining budget, then did two `await`s before counting
 * the attempt. Two overlapping runs both read "1 slot free" in that window and
 * both spawned `npm update` for the same package into the same unlocked
 * `node_modules`. A caller cannot reproduce that race with this signature:
 * there is no point between the check and the take at which the event loop can
 * hand control to the other run.
 */
export function reserveManagedToolRefreshSlot(maxPerSession: number): boolean {
	if (refreshesThisSession >= maxPerSession) return false;
	refreshesThisSession += 1;
	return true;
}

/**
 * Hand a reserved slot back, for a run that reserved one and then found
 * nothing to do. Only a run that never reached a spawn may call this: a slot
 * is spent by the ATTEMPT, so a failed `npm update` keeps it and the session
 * does not retry a second tool in its place.
 */
export function releaseManagedToolRefreshSlot(): void {
	if (refreshesThisSession > 0) refreshesThisSession -= 1;
}

/**
 * Restore the session's refresh budget. Wired into `handleSessionStart`: the
 * budget is a per-SESSION allowance, and a process that serves many sessions
 * must get a fresh one each time rather than refreshing one tool at launch and
 * never looking again (the #1266/#1490/#1497/#1535 process-lifetime-latch
 * shape). Also used directly by tests.
 */
export function resetManagedToolRefreshSession(): void {
	refreshesThisSession = 0;
}
