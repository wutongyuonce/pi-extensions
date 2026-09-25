/**
 * The class name of a caught error, and NOTHING else — never the message,
 * which for some callers could quote content they do not want to risk
 * surfacing (a config-core bug thrown while walking the raw, untrusted
 * parsed document; a whole-resolution catch wrapping several stages at
 * once). One leaf so that guarantee does not grow a third, fourth, and
 * fifth hand-rolled `error instanceof Error ? error.name : "unknown error"`
 * (#2451 — `clients/config-warn.ts`'s `normalizeParseErrorReason` (the
 * `classOnly` option), `clients/config-core/normalize.ts`,
 * `clients/config-core/resolve.ts`, and `clients/lens-config.ts` all call
 * this instead of inlining their own copy).
 *
 * Zero imports of its own, deliberately: `config-core/` must never import a
 * sink (`clients/config-warn.ts` -> the degradation ledger) — that exact
 * import closed seven cycles when #2426 removed it, and importing
 * `normalizeParseErrorReason` from inside `config-core/` to get this one
 * value back would reopen them. This leaf is how `config-warn.ts` and
 * `config-core/*.ts` share ONE implementation without either importing the
 * other.
 */
export function errorClassName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown error";
}
