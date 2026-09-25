/**
 * One-shot invocation detection, shared across the session_start-scheduled
 * background work that must NOT run — or retain the process — in print mode
 * (#1154 quick-mode warmup, #1153 orphan-reaper).
 *
 * `pi -p` / `pi --print` is a one-shot: the host computes a single turn and
 * exits. Work scheduled to warm caches / clean up state for a *future* session
 * in the same process is pure waste in this mode AND — when it arms a
 * referenced libuv handle (a non-`unref`'d timer, an LSP child, an fs walk)
 * with no session_shutdown teardown — keeps the already-settled one-shot
 * process alive. That is the referenced-handle retention class of
 * #1097/#1110/#1148/#1149 and the located #1122 hypothesis-A concern.
 *
 * argv is read live (not captured at module load) so tests can drive it; the
 * flag never changes within a real process, and there is no hot-path caller,
 * so recomputing is free. This mirrors the print detection in
 * `runtime-session.ts`'s `resolveStartupMode` — keep them a single source.
 */
export function isPrintMode(argv: readonly string[] = process.argv): boolean {
	return argv.includes("--print") || argv.includes("-p");
}
