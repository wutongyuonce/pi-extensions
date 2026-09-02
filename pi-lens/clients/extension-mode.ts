/**
 * Host run-mode awareness (#1334 S2).
 *
 * pi tells every extension which mode it is running in — verified against the
 * pinned host types (`@earendil-works/pi-coding-agent/dist/core/extensions/
 * types.d.ts`):
 *
 *   export type ExtensionMode = "tui" | "rpc" | "json" | "print";   // line 208
 *   interface ExtensionContext { mode: ExtensionMode; hasUI: boolean; … }
 *                                                       // lines 212-215
 *
 * The host's own comment on `mode` is the contract this module encodes:
 * *"Use `"tui"` to guard terminal-only UI such as custom components."*
 *
 * pi-lens previously derived terminal ownership from nothing at all — it
 * mounted its widget and chattered through `ui.notify` in every mode, including
 * `print` and `json`, where the process is a one-shot producing machine- or
 * pipe-consumed output and there is no live TUI to render into.
 *
 * Two independent questions, deliberately NOT the same predicate:
 *
 *   - *Is there a TUI to mount a custom component into?* Only `"tui"`. `rpc`
 *     has `hasUI: true` (dialogs work over the protocol) but no terminal
 *     component surface, so the widget must not mount there either.
 *   - *Should proactive chatter reach the human?* No in `print` and `json` —
 *     one-shot/machine output. Yes in `tui` and `rpc`.
 *
 * This is complementary to, and independent of, the #1338/#1333 console guard:
 * that establishes "never write raw to the terminal"; this decides whether the
 * HOST's own render path should be used at all in a given mode.
 *
 * Stateless by design: `mode` lives on the ctx pi hands to every event and
 * command handler, so each call site reads it from the ctx it already has —
 * no latched global to go stale across a session replacement.
 */

/** `ExtensionMode` plus the "older host, no `mode` field" case. */
export type ExtensionRunMode = "tui" | "rpc" | "json" | "print" | "unknown";

const KNOWN_MODES = new Set<string>(["tui", "rpc", "json", "print"]);

/**
 * Feature-detected read of `ctx.mode`.
 *
 * Returns `"unknown"` for a host that predates the field, or for any value
 * outside the four documented modes (a future pi may add one; treating an
 * unrecognized mode as "unknown" keeps current behavior rather than guessing
 * a suppression that could hide output).
 */
export function readExtensionMode(ctx: unknown): ExtensionRunMode {
	try {
		const mode = (ctx as { mode?: unknown } | null | undefined)?.mode;
		if (typeof mode !== "string" || !KNOWN_MODES.has(mode)) return "unknown";
		return mode as ExtensionRunMode;
	} catch {
		return "unknown";
	}
}

/**
 * Whether a terminal-only custom component (the pi-lens diagnostics widget) can
 * be mounted. `"unknown"` mounts — older hosts must behave exactly as before.
 */
export function supportsTuiWidget(mode: ExtensionRunMode): boolean {
	return mode === "tui" || mode === "unknown";
}

/**
 * Whether proactive `ui.notify` chatter should be suppressed (logged only).
 * True only for the two non-interactive one-shot modes.
 */
export function suppressesUserNotify(mode: ExtensionRunMode): boolean {
	return mode === "print" || mode === "json";
}

/** Short human-readable reason for a suppression, for the ndjson/debug log. */
export function modeSuppressionNote(mode: ExtensionRunMode): string {
	return `suppressed in "${mode}" mode (no interactive TUI)`;
}
