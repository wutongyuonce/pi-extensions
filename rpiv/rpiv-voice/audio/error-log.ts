/**
 * error-log — append-only diagnostic sink for the dictation pipeline.
 *
 * The pipeline cannot write to stderr (corrupts the active TUI render) and
 * cannot surface failures via `notify` without churning the chat history. So
 * recognition errors went silent, leaving users with mysterious gaps in the
 * transcript and no breadcrumbs.
 *
 * This module appends one line per failure to
 * `~/.config/rpiv-voice/errors.log`. Writes are best-effort and synchronous —
 * a write failure is itself swallowed (we cannot log the log failure without
 * re-entering the same hazard).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".config", "rpiv-voice");
const LOG_PATH = join(LOG_DIR, "errors.log");

export function getErrorLogPath(): string {
	return LOG_PATH;
}

export function appendErrorLog(scope: string, err: unknown): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
		appendFileSync(LOG_PATH, line, "utf-8");
	} catch {
		// Best-effort: a logging-path failure must never re-throw into the
		// dictation pipeline. The TUI is the user's only feedback channel and
		// stderr would corrupt it.
	}
}

// Sibling of appendErrorLog for non-error breadcrumbs (e.g. "mic opened
// at 48 kHz in resample-rms mode"). Same sink, same best-effort
// semantics — separating the entry point keeps the call sites honest
// about whether something actually went wrong.
export function appendDiagnosticLog(scope: string, message: string): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
		appendFileSync(LOG_PATH, line, "utf-8");
	} catch {
		// See appendErrorLog above.
	}
}
