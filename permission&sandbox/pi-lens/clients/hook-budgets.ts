/**
 * The per-hook wall-clock budgets, in ONE table (#2523).
 *
 * ## What a budget here means
 *
 * The maintainer contract behind #2523: only the write/edit `tool_result`
 * path may block pi's host loop. `session_start`, `turn_end`, `agent_end`,
 * `agent_settled` and read-only `tool_result` must either finish inside a
 * small bound or deliver their work OFF-hook (`clients/deferred-lsp-work.ts`,
 * `publishActionableWarningsReport` #2509, the test-runner `agent_settled`
 * delivery #2366, the cascade deferred settle #450) — deliver, never drop.
 *
 * A number here is the TOTAL wall time the hook may spend, not a per-await
 * allowance. `0` means the hook may not await anything at all: whatever it
 * does must be synchronous bookkeeping or fire-and-forget with its own
 * bound.
 *
 * The numbers are the contract's, not a measurement: they are the ceilings
 * the maintainer set for what the host may be made to wait for. #2523's
 * sweep measured today's reality against them —  `turn_end` p50 3687 ms /
 * p90 14246 ms against a 3000 ms budget, `agent_end` p90 10043 ms against
 * 1000 ms — which is what makes this table a target rather than a
 * description.
 *
 * ## Why a table, and why it is not wired yet
 *
 * Slice 1 of #2523 ships the enforcement PRIMITIVE (`bounded()` in
 * `clients/deadline-utils.ts`) and the guard that makes a new unbounded hook
 * await impossible to add (`tests/config/hook-await-bounds.test.ts`). It
 * deliberately changes NO hook's behavior. This table exists now so the
 * guard's exemption table can say which hook each unbounded await belongs to
 * — a claim that is checked, since every exemption's `hook` field must be a
 * key of {@link HOOK_WALL_BUDGET_MS}. Slice 2 (AC3-AC8) wires it into the
 * outer `bounded()` around each registered handler.
 *
 * #1978's phase-budget watchdog is the general form of this idea ("every
 * recorded duration gets a declared budget"). When it lands it must CONSUME
 * this table for the hook family rather than declare a second set of hook
 * numbers — AGENTS.md's single-source-of-truth rule, and #2523 AC7 says so
 * explicitly.
 */

/**
 * Hook families with a declared budget. Two `tool_result` entries because the
 * contract splits on the ONE axis that matters: an edit is the only thing the
 * host may legitimately be made to wait 10 s for, and a read-only tool call
 * (Read/Grep/Glob/Bash — the overwhelming majority) may not be made to wait
 * for analyzer bootstrap at all (#2523 AC5). The split is by mutation
 * classification, the same seam `clients/mutating-tool.ts` already owns.
 */
export type HookBudgetKey =
	| "session_start"
	| "turn_start"
	| "turn_end"
	| "agent_end"
	| "agent_settled"
	| "tool_result_read_only"
	| "tool_result_edit"
	| "session_shutdown"
	| "context"
	| "session_before_fork";

/**
 * Total wall-clock budget per hook, in milliseconds. `0` = may not await.
 *
 * `session_start` is the one VISIBLE budget: 5 s of startup is work the user
 * is already watching a progress line for. Everything else is time the user
 * did not ask to spend.
 */
export const HOOK_WALL_BUDGET_MS: Readonly<Record<HookBudgetKey, number>> =
	Object.freeze({
		/** Visible startup work; the user is watching a progress line. */
		session_start: 5000,
		/** Pure bookkeeping — nothing here may await (#2523 contract). */
		turn_start: 0,
		/** Measured p50 3687 ms / p90 14246 ms today. The gap IS the issue. */
		turn_end: 3000,
		/** Measured p90 10043 ms today, from one unbounded pipeline re-entry. */
		agent_end: 1000,
		/** The designated place for settled-time sweeps; the widest non-edit budget. */
		agent_settled: 10000,
		/** Read/Grep/Glob/Bash: must never await analyzer bootstrap (AC5). */
		tool_result_read_only: 500,
		/** The ONLY path the contract lets block the host, and only this long. */
		tool_result_edit: 10000,
		/** Teardown: spawning or awaiting here aborts libuv (#234). */
		session_shutdown: 0,
		/** Synchronous message contribution; the host is blocked on the answer. */
		context: 0,
		/** Fork bookkeeping; the session is being replaced under it. */
		session_before_fork: 0,
	});

/**
 * Hook families that may appear on the degradation ledger's HOOK axis.
 *
 * A superset of {@link HookBudgetKey}, because two real execution contexts
 * carry no wall budget in the maintainer's contract yet still have to be
 * NAMEABLE when a bound fires under them:
 *
 * - `tool_call` — the pre-dispatch hook (`clients/runtime-tool-call.ts`). The
 *   contract gives it no ceiling of its own; work there is bounded per-await.
 * - `off_hook` — deliberately deferred work (`clients/deferred-lsp-work.ts`,
 *   the cascade deferred settle, the actionable-warnings deferred pull). It is
 *   the ANSWER to a blown hook budget, so charging its exceedances to the hook
 *   that deferred it inverts the reading: `turn_end` would look over budget
 *   precisely because it correctly moved work off itself (#2557 review F3).
 *
 * `bounded()` takes this type rather than a bare `string` so a call site
 * cannot put something that is not a hook on the hook axis. #2557 review F7:
 * `clients/bootstrap.ts` passed its `options.reason` (`"session-start-scans"`,
 * `"tool-call-complexity-baseline"`) as `hook`, which made
 * `hook-await-exceeded` subjects unjoinable with every other hook-keyed record
 * and unreadable against this budget table. That is now a type error.
 */
export type LedgerHookKey = HookBudgetKey | "tool_call" | "off_hook";

/** Every declared hook family, for sweeps that must enumerate them. */
export const HOOK_BUDGET_KEYS = Object.keys(
	HOOK_WALL_BUDGET_MS,
) as HookBudgetKey[];

/** Type guard for a string that names a declared hook family. */
export function isHookBudgetKey(value: string): value is HookBudgetKey {
	return Object.hasOwn(HOOK_WALL_BUDGET_MS, value);
}
