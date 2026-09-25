/**
 * The one owner of "work that keeps talking to the LSP service after the hook
 * that started it has returned" (#2504 review round 2, F3).
 *
 * #2504 moved the cold-cache actionable-warnings fresh-pull loop off the
 * awaited `turn_end` hook. That loop then had effectively ONE bound: it
 * captured the COMPLETED turn's `ctx.signal` — which `index.ts` clears from
 * the ambient slot in its `finally`, so it can never fire — plus a 60 s wall
 * deadline checked only BETWEEN files. A wedged `getDiagnostics` was therefore
 * unbounded, the loop kept opening files (and could re-spawn servers) after
 * `turn_end` returned and after the LSP idle reset, a `session_shutdown`
 * landing mid-loop hit the #234 spawn-at-teardown shape, and the handle was a
 * module-level `let` with no reset that a second deferral simply overwrote.
 *
 * This module supplies the missing halves: ONE registered handle (held by
 * whichever deferral got there first, released when its work settles — see
 * `armDeferredLspWork`) and ONE abort signal that
 * `resetLSPService` fires — the single choke point through which
 * `session_shutdown`, `session_start` and the idle reset all retire the
 * service, so no caller has to remember to wire each lifecycle event
 * separately. Aborting only ever settles a promise; it never spawns, which is
 * what AGENTS.md's #234 teardown rule requires of anything reachable from
 * `session_shutdown`.
 *
 * Deliberately a zero-dependency leaf, for the same reason
 * `map-with-concurrency.ts` is one: `clients/lsp/index.ts` must not gain an
 * import edge to `actionable-warnings.ts` (and through it `lsp/edits.ts`,
 * `lsp-mutation.ts`, the durable store …) for a 20-line handle registry.
 */

let deferredController: AbortController | undefined;
let deferredWork: Promise<void> | undefined;

/**
 * Abort the in-flight deferred LSP work, if any, and drop the slot.
 *
 * Safe at teardown: it settles a promise and spawns nothing. Idempotent — a
 * second call with no armed work is a no-op.
 */
export function abortDeferredLspWork(reason: string): void {
	const controller = deferredController;
	deferredController = undefined;
	deferredWork = undefined;
	controller?.abort(new Error(reason));
}

/**
 * Claim the deferred-work slot, or `undefined` when an incumbent still holds
 * it. THE INCUMBENT WINS (#2504 review round 3, F-A(d)).
 *
 * Round 2 had arming ABORT the previous deferral, reasoning that two loops
 * must not run concurrently against one LSP service. The first half of that is
 * right and still holds — there is exactly one slot. The second half was
 * backwards about which loop to keep. A deferral is armed by a turn that
 * primed NO LSP cache, which in a live editing session is every turn; so every
 * turn cancelled its predecessor, and an aborted loop publishes nothing by
 * design (its service is presumed gone). Back-to-back editing turns therefore
 * delivered NOTHING AT ALL — the exact delivery AC #2504 exists to preserve.
 *
 * Keeping the incumbent inverts that: the loop that is already talking to the
 * service runs to completion and publishes, and the newcomer is declined and
 * says so out loud. The cost is stated rather than silent — the declining
 * turn's cold files go unchecked on this channel until a later turn defers.
 *
 * Declining cannot latch. `registerDeferredLspWork` releases the slot the
 * moment the work settles, and the loop itself is bounded twice over
 * (`ACTIONABLE_WARNINGS_DEFERRED_BUDGET_MS` between files, a per-round-trip
 * timeout inside them), so an incumbent always yields the slot in bounded
 * time. Teardown is unaffected: `abortDeferredLspWork` still evicts the
 * incumbent unconditionally, which is how `resetLSPService` retires it.
 */
export function armDeferredLspWork(): AbortSignal | undefined {
	if (isDeferredLspWorkArmed()) return undefined;
	const controller = new AbortController();
	deferredController = controller;
	deferredWork = undefined;
	return controller.signal;
}

/**
 * Register the armed work's promise so callers (and tests) have something to
 * await. Ignored when the slot has already been re-armed or aborted since — a
 * late registration must not resurrect a retired handle.
 *
 * Registration also arranges the RELEASE (#2504 review round 3, F-A(d)):
 * because the slot now turns a newcomer away rather than evicting the
 * incumbent, something has to hand it back, and the only correct moment is
 * when the work settles. Guarded on identity, so a slot re-armed or aborted in
 * the meantime is never cleared by a stale finalizer.
 */
export function registerDeferredLspWork(
	signal: AbortSignal,
	work: Promise<void>,
): void {
	if (deferredController?.signal !== signal) return;
	deferredWork = work;
	void work.finally(() => {
		if (deferredController?.signal !== signal) return;
		deferredController = undefined;
		deferredWork = undefined;
	});
}

/** The in-flight deferred work, or an already-resolved promise when idle. */
export function awaitDeferredLspWork(): Promise<void> {
	return deferredWork ?? Promise.resolve();
}

/** True while a deferral holds the slot and has not been aborted. */
export function isDeferredLspWorkArmed(): boolean {
	return deferredController?.signal.aborted === false;
}
