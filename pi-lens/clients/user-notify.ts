/**
 * The HUMAN channel for degradations discovered deep in `clients/` (#1333).
 *
 * Most of what the migrated `console.*` sites emitted is LOG-audience and
 * belongs in an ndjson sink (`clients/extension-log.ts`). A small set is
 * genuinely user-facing — "the config file you wrote is being ignored", "this
 * language's grammar could not be fetched, so its structural features are
 * degraded", "the WASM runtime aborted; restart to recover". Those must reach
 * the human through the HOST's own render path, never a raw terminal write
 * (pi owns the terminal — see the module doc in `extension-log.ts`).
 *
 * `index.ts` wires a getter at extension init; modules deep in the tree call
 * `notifyUserDegradation` without knowing anything about `ctx`. Per the
 * #338/#798 detached-callback rule the notifier is resolved through a GETTER
 * at delivery time — never captured once, because a session replacement
 * invalidates the previously captured `ctx.ui`.
 *
 * Fail-soft by construction: with no host wired (MCP server, CLI, tests) this
 * is a no-op and the ndjson sink remains the sole destination — the message is
 * never lost, only un-rendered.
 */

export type UserNotifyLevel = "info" | "warning" | "error";

export type UserNotifier = (message: string, level?: UserNotifyLevel) => void;

let notifierGetter: (() => UserNotifier | undefined) | undefined;

/** Called once from the extension entry with a getter over the live `ctx.ui.notify`. */
export function wireUserNotifier(
	portsOrGetter:
		| import("./host-ports.js").HostPorts
		| (() => UserNotifier | undefined),
): void {
	notifierGetter =
		typeof portsOrGetter === "function"
			? portsOrGetter
			: () => portsOrGetter.notify.user;
}

/** Test/teardown-only: drop the wired host. */
export function resetUserNotifier(): void {
	notifierGetter = undefined;
}

/** True when a host render path is available (for callers that want to branch). */
export function hasUserNotifier(): boolean {
	return notifierGetter !== undefined;
}

/**
 * Best-effort delivery of a user-facing degradation. Never throws — a stale
 * `ctx` after a session replacement must degrade to a no-op, not break the
 * diagnostic path that called it.
 */
export function notifyUserDegradation(
	message: string,
	level: UserNotifyLevel = "warning",
): void {
	try {
		const notify = notifierGetter?.();
		notify?.(message, level);
	} catch {
		// The ndjson sink already holds this message; a dead host is not an error.
	}
}
