/**
 * Vanished-instance markers (#1123 item 2, first slice — instance health).
 *
 * `deregisterInstance()` (clients/instance-registry.ts) SYNCHRONOUSLY removes
 * a process's own entry from `instances.json` on a clean `session_shutdown`.
 * That means the entry's mere PRESENCE in the registry, combined with a
 * pid-confirmed-dead owner, is already proof the process never reached that
 * shutdown path — no separate "clean shutdown" flag is needed on
 * `InstanceEntry` (the registry already carries `heartbeatAt`/`rssBytes`,
 * which is exactly the "lastSeen"/"rss" pair this marker needs; both are
 * used AS-IS, per the instruction to add fields only if missing).
 *
 * `sweepOrphans()` (clients/instance-reaper.ts) already prunes these exact
 * dead-pid entries out of the registry as part of #472's orphan-LSP reap —
 * so this marker's read MUST happen against a snapshot taken before (or
 * independently of) that prune, or the vanished set will already be empty by
 * the time this runs. `logVanishedInstances` therefore takes the registry
 * snapshot as an argument rather than reading it itself, so the caller
 * controls ordering (see index.ts's session_start wiring, which reads once
 * and passes the same snapshot to both this marker and `sweepOrphans`).
 */

import { logSessionStart } from "./sessionstart-logger.js";
import type { InstanceEntry } from "./instance-registry.js";
import { realIsPidAlive } from "./instance-reaper.js";

export interface VanishedInstance {
	pid: number;
	/** `InstanceEntry.heartbeatAt` — the last heartbeat this process ever
	 *  wrote before it stopped updating the registry. */
	lastSeenAt: string;
	/** `InstanceEntry.rssBytes` at that last heartbeat. */
	rssBytes: number;
}

/**
 * PURE: registry entries whose owning pid is confirmed dead. Every such entry
 * is, by construction (see module docstring), one that exited without
 * reaching `deregisterInstance()`. Uses the SAME conservative liveness
 * contract as the reaper (`isPidAlive`, defaulting to `realIsPidAlive`):
 * ESRCH-only-means-dead, any ambiguous signal (EPERM, unknown) stays "alive"
 * — never flag a live-but-unverifiable instance as vanished.
 */
export function detectVanishedInstances(
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
): VanishedInstance[] {
	return registry
		.filter((entry) => !isPidAlive(entry.pid))
		.map((entry) => ({
			pid: entry.pid,
			lastSeenAt: entry.heartbeatAt,
			rssBytes: entry.rssBytes ?? 0,
		}));
}

/**
 * Log one `sessionstart.log` line per vanished instance found in `registry`.
 * Best-effort (never throws into `session_start`) and read-only — this
 * function never mutates or prunes the registry; that stays the reaper's job.
 */
export function logVanishedInstances(
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean = realIsPidAlive,
): void {
	try {
		const vanished = detectVanishedInstances(registry, isPidAlive);
		for (const instance of vanished) {
			const rssMb = Math.round(instance.rssBytes / (1024 * 1024));
			logSessionStart(
				`previous instance pid ${instance.pid} last seen ${instance.lastSeenAt} (RSS ${rssMb}MB) exited without shutdown`,
			);
		}
	} catch {
		// best-effort observability — never fail session_start over this
	}
}
