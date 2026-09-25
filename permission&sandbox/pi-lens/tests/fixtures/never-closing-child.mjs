/**
 * #1679 regression fixture: a child that never emits 'close' on its own —
 * it ignores SIGTERM and keeps the event loop alive, simulating a
 * wedged/daemonized child (a hung Chrome/CDP process). Only a forceful
 * kill (SIGKILL on POSIX, `taskkill /F` on Windows) ends it.
 *
 * Used by tests/scripts/playground-verify-rule-bounded-wait.test.ts to
 * prove runCdp/runChrome in scripts/playground-verify-rule.mjs bound the
 * wait instead of hanging forever.
 */

process.on("SIGTERM", () => {
	// Ignore — stay alive so the parent must escalate to a forceful kill.
});

setInterval(() => {}, 60_000);
