/**
 * The degradation ledger's field-truncation policy, as a leaf module (#1816).
 *
 * It lives here rather than in `degradation-ledger.ts` because reason BUILDERS
 * (`formatToolFailure`, `firstOutputLine`) need the bound without importing the
 * ledger itself. Test files routinely `vi.mock` the ledger to observe recorded
 * degradations; a builder that reached through that mock for a constant would
 * break every one of them.
 */

/** The single truncation bound for every ledger field, and for the reasons callers build. */
export const LEDGER_FIELD_MAX = 200;

export function normalizeForLedger(value: unknown): string {
	return String(value ?? "unknown");
}

/** Bound a value to `LEDGER_FIELD_MAX`, marking the elision. */
export function truncateForLedger(value: unknown): string {
	const text = normalizeForLedger(value);
	return text.length > LEDGER_FIELD_MAX
		? `${text.slice(0, LEDGER_FIELD_MAX)}…`
		: text;
}
