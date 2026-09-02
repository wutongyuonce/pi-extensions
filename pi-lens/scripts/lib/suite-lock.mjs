/**
 * scripts/lib/suite-lock.mjs
 *
 * Core lock primitives for the machine-wide test-suite lock (#1101), used by
 * scripts/with-test-lock.mjs. Named to avoid the repo's `test-*.mjs`
 * .gitignore pattern (reserved for ephemeral scratch fixtures) — kept in
 * its own importable module (rather than inline in with-test-lock.mjs) so a
 * unit test can exercise acquire/release/contention/stale-takeover directly,
 * with short poll intervals, without spawning a real process tree.
 *
 * Pattern mirrors clients/installer/index.ts's `.install.lock`
 * (acquireInstallLock / isProcessAlive): atomic create via
 * fs.open(path, "wx"), owner JSON body `{ pid, startedIso }`, and "stale once
 * the recorded PID is confirmed dead" takeover. This is a minimal standalone
 * re-implementation (not an import of clients/installer/index.ts) because
 * scripts/ must run as plain .mjs before `npm run build` compiles
 * clients/*.ts to clients/*.js — see that file for the original if the two
 * ever need to be reconciled. ONE deliberate divergence from that original:
 * `.install.lock` ALSO ages out a lock with a still-live, readable PID once
 * it exceeds the owner's install bound + slack (#946 F1's PID-recycle
 * defense — an install has a known bounded duration to size that against).
 * This lock does NOT do that (see point 5 below) — a test-suite run has no
 * such bound.
 *
 * OS-agnosticism, explicitly:
 *  1. Locking is done ONLY via atomic file create (`fs.open(path, "wx")`),
 *     which is atomic on both POSIX and Windows filesystems — no
 *     flock/fcntl/byte-range lock APIs, which differ across OSes and don't
 *     exist uniformly on Windows.
 *  2. PID liveness is `process.kill(pid, 0)`; EPERM is treated as ALIVE
 *     (Windows returns EPERM, not ESRCH, for some protected-but-live
 *     processes), so only ESRCH (or any non-EPERM error) is treated as dead.
 *  3. Correctness never depends on the release handler running: a hard kill
 *     (Windows `taskkill /F`, POSIX SIGKILL) skips both the `finally` in
 *     with-test-lock.mjs and the best-effort `process.once("exit", ...)`
 *     cleanup below. The stale-after-PID-dead takeover below is the actual
 *     recovery path and is covered by a dedicated test ("lockfile exists,
 *     recorded PID dead -> immediate takeover", no age/timeout wait needed).
 *  4. Windows can transiently hold a file open (AV scanners, search
 *     indexer) so unlinks can fail with EBUSY/EPERM even when no other
 *     pi-lens process is involved. Both stale-takeover removal and release
 *     retry the unlink a few times with a short backoff before giving up
 *     (and logging if they ultimately fail — the next waiter's stale check
 *     still recovers it). A momentarily-unreadable-but-present lock file
 *     during acquire is treated as CONTENDED (wait/retry), never as a crash.
 *  5. The lock body records `{ pid, startedIso }` (an ISO-8601 string, not
 *     just an epoch number) so heartbeat/timeout messages are human-legible
 *     ("held by PID <pid> since <startedIso>") for exactly this diagnosis:
 *     unlike `.install.lock`, this lock has NO age-expiry path for a lock
 *     whose recorded PID still reads as alive — deliberately, since a
 *     full-suite run has no bounded duration for a timeout to be sized
 *     against, and the owner never touches the lock file's mtime while
 *     holding it (so an mtime-based bound would just be a second arbitrary
 *     guess). The consequence: if the OS recycles a dead PID for an
 *     unrelated live process before a waiter re-checks, that waiter treats
 *     the lock as still (wrongly) held and WAITS FOREVER — recoverable only
 *     by a human reading the heartbeat's pid+startedIso and deleting the
 *     lock file by hand. This is strictly worse than the installer's
 *     bounded wait for that one PID-recycle case, traded deliberately for
 *     never taking over a run that is still genuinely in progress. Possible
 *     future hardening: have the owner periodically touch the lock file's
 *     mtime while still running, so a waiter could safely distinguish
 *     "stale mtime + dead-looking PID" from "recycled PID, still running" —
 *     not implemented here.
 *  6. Paths go through `os.homedir()` / `path.join()` throughout, never
 *     hand-built strings. Tests pass an explicit `lockPath` under a
 *     `fs.mkdtemp()` directory (or set `PI_LENS_HOME` to one) so they never
 *     touch the developer's real `~/.pi-lens`, and behavior doesn't depend
 *     on path casing or separator conventions.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Best-effort synchronous cleanup on process exit (mirrors
// activeInstallLocks in clients/installer/index.ts): if the wrapper is
// killed before its `finally` runs, still try to drop the lock file so the
// next owner doesn't have to wait out a full PID-liveness check against a
// dead process. Purely best-effort — a hard kill (SIGKILL / taskkill /F)
// skips this too, which is why correctness rests on the stale-PID-dead
// takeover, not on this handler running (see file header, point 3).
/** @type {Set<string>} */
const activeLocks = new Set();
let exitCleanupRegistered = false;

function registerExitCleanup() {
	if (exitCleanupRegistered) return;
	exitCleanupRegistered = true;
	process.once("exit", () => {
		for (const lockPath of activeLocks) {
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// Best effort; the next owner verifies this PID is dead.
			}
		}
	});
}

/**
 * Default lock location: ONE machine-wide file, not per-repo. Concurrent
 * full-suite runs contend for the same machine resources (CPU, RAM) even
 * when they check out different worktrees of the same repo, or entirely
 * different repos — so this lock intentionally does NOT key on the repo
 * root path. `PI_LENS_HOME` (same override used by
 * clients/file-utils.ts#getGlobalPiLensDir) relocates it, primarily so
 * tests can point at an isolated temp home.
 *
 * @returns {string}
 */
export function getLockPath() {
	const override = process.env.PI_LENS_HOME?.trim();
	const home = override
		? path.resolve(override)
		: path.join(os.homedir(), ".pi-lens");
	return path.join(home, "test-suite.lock");
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the PID exists but we lack permission to signal it —
		// still alive (observed on Windows for some protected live
		// processes). Any other error (ESRCH, etc.) means it's gone.
		const error = /** @type {NodeJS.ErrnoException} */ (err);
		return error.code === "EPERM";
	}
}

/**
 * @param {{ pid?: unknown, startedIso?: unknown } | null} owner
 * @returns {string}
 */
function describeOwner(owner) {
	if (!owner || typeof owner.pid !== "number" || !Number.isInteger(owner.pid)) {
		return "unknown owner";
	}
	const started =
		typeof owner.startedIso === "string" ? owner.startedIso : "unknown time";
	return `PID ${owner.pid} since ${started}`;
}

/**
 * Remove a lock file, retrying briefly on transient Windows file-hold
 * errors (EBUSY/EPERM from AV/indexer) instead of failing immediately.
 * Returns true if the file was removed (or already gone), false if it
 * could not be removed after retries (logged by the caller; the next
 * waiter's stale-PID check still recovers it).
 *
 * @param {string} lockPath
 * @param {{ retries?: number, delayMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
async function removeLockWithRetry(lockPath, opts = {}) {
	const { retries = 3, delayMs = 50 } = opts;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fsp.unlink(lockPath);
			return true;
		} catch (err) {
			const error = /** @type {NodeJS.ErrnoException} */ (err);
			if (error.code === "ENOENT") return true;
			const transient = error.code === "EBUSY" || error.code === "EPERM";
			if (!transient || attempt === retries) {
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return false;
}

/**
 * Acquire the test-suite lock, waiting (with a heartbeat) if another process
 * already holds it. Resolves once the lock file has been atomically created
 * by this process; the caller MUST call the returned `release()` in a
 * `finally`.
 *
 * @param {object} [options]
 * @param {string} [options.lockPath] Override the lock file path (default: getLockPath()).
 * @param {number} [options.pollIntervalMs] Poll backoff while contended (default: env PI_LENS_TEST_LOCK_POLL_MS or 500).
 * @param {number} [options.heartbeatIntervalMs] Max gap between heartbeat log lines while waiting (default: env PI_LENS_TEST_LOCK_HEARTBEAT_MS or 15000).
 * @param {number} [options.timeoutMs] Give up after this long waiting; 0/undefined = wait forever (default: env PI_LENS_TEST_LOCK_TIMEOUT_MS or 0).
 * @param {(message: string) => void} [options.log] Heartbeat sink (default: console.error).
 * @param {number} [options.staleMaxAgeMs] Age (ms) after which an unreadable/empty lock is treated as stale even without a readable owner PID (default: 5 minutes).
 * @returns {Promise<{ release: () => Promise<void>, lockPath: string }>}
 */
export async function acquireTestLock(options = {}) {
	const lockPath = options.lockPath || getLockPath();
	const pollIntervalMs =
		options.pollIntervalMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_POLL_MS) || 500);
	const heartbeatIntervalMs =
		options.heartbeatIntervalMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_HEARTBEAT_MS) || 15_000);
	const timeoutMs =
		options.timeoutMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_TIMEOUT_MS) || 0);
	const staleMaxAgeMs = options.staleMaxAgeMs ?? 5 * 60_000;
	const log = options.log || ((message) => console.error(message));

	await fsp.mkdir(path.dirname(lockPath), { recursive: true });

	const start = Date.now();
	let lastHeartbeat = 0;

	// eslint-disable-next-line no-constant-condition -- bounded by timeoutMs when set
	while (true) {
		try {
			const handle = await fsp.open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({
						pid: process.pid,
						startedIso: new Date().toISOString(),
					}),
				);
			} finally {
				await handle.close();
			}
			activeLocks.add(lockPath);
			registerExitCleanup();
			let released = false;
			return {
				lockPath,
				release: async () => {
					if (released) return;
					released = true;
					activeLocks.delete(lockPath);
					const removed = await removeLockWithRetry(lockPath);
					if (!removed) {
						log(
							`[test-lock] warning: could not remove lock file at ${lockPath} ` +
								`after retries (Windows AV/indexer hold?); the next waiter's ` +
								`stale-PID check will recover it`,
						);
					}
				},
			};
		} catch (err) {
			const error = /** @type {NodeJS.ErrnoException} */ (err);
			// EBUSY/EPERM on the CREATE itself (not just on unlink — see
			// removeLockWithRetry) is a real, observed Windows race: a lock file
			// that was JUST unlinked by another process's release() can still
			// transiently reject a fresh `open(path, "wx")` with EPERM/EBUSY
			// before the OS fully drops the deleted file's handle. Treat that
			// exactly like EEXIST — contended, retry — rather than throwing;
			// otherwise a real two-waiter release/re-acquire handoff can
			// randomly crash the second waiter instead of letting it proceed.
			if (
				error.code !== "EEXIST" &&
				error.code !== "EBUSY" &&
				error.code !== "EPERM"
			) {
				throw error;
			}

			// The file exists but may be momentarily unreadable (a racing
			// writer, or a transient Windows file hold) — that is CONTENDED,
			// not a crash: treat it as "owner unknown" and keep waiting rather
			// than throwing.
			/** @type {{ pid?: unknown, startedIso?: unknown } | null} */
			let owner = null;
			try {
				owner = JSON.parse(await fsp.readFile(lockPath, "utf8"));
			} catch {
				// fall through to the mtime-based staleness check below
			}

			let stale = false;
			if (
				owner &&
				typeof owner.pid === "number" &&
				Number.isInteger(owner.pid) &&
				owner.pid > 0
			) {
				// Immediate takeover as soon as the recorded PID is confirmed
				// dead — no age/timeout wait required (point 3 above).
				stale = !isProcessAlive(owner.pid);
			} else {
				try {
					const stat = await fsp.stat(lockPath);
					stale = Date.now() - stat.mtimeMs > staleMaxAgeMs;
				} catch {
					// Raced a release between open() failing and stat() (both the
					// owner-read above and this stat found nothing) — loop and
					// retry acquisition. Still sleep pollIntervalMs first: without
					// it this path is an unbounded tight retry loop that ignores
					// timeoutMs (the deadline check below is never reached from
					// here), which would spin the CPU and could wait past
					// timeoutMs unbounded if this race kept re-triggering.
					await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
					continue;
				}
			}

			if (stale) {
				// KNOWN RACE (inherited as-is from clients/installer/index.ts's
				// acquireInstallLock, same shape there): between deciding `stale`
				// above and the unlink below, the dead/aged-out owner could
				// theoretically have been reaped by a DIFFERENT waiter that has
				// already re-created the lock as its own fresh, live owner — this
				// waiter would then unlink that fresh lock out from under it
				// (ABA). The window is milliseconds and only reachable right after
				// a crash (a live owner's PID is never "stale"), so it's left
				// as-is rather than fixed here; a real fix (re-read + compare the
				// owner body immediately before unlink) would need to land in
				// both places per the repo's bug-class-sweep discipline, not just
				// this one. See PR #1112 review discussion (#1101).
				const removed = await removeLockWithRetry(lockPath);
				if (!removed) {
					// Another process may hold a transient handle on it; loop and
					// re-evaluate rather than looping tightly forever.
					await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
				}
				continue;
			}

			const now = Date.now();
			if (timeoutMs > 0 && now - start > timeoutMs) {
				// Message shape is pinned: tests/scripts/suite-lock.test.ts:233
				// asserts against it directly, and scripts/pre-push-targeted-tests.mjs
				// greps a caller's stderr for "timed out after \d+ms waiting for
				// test-suite lock" to tell a lock timeout (push proceeds, #1804 F2)
				// apart from a real test failure (push blocks). Reword both call
				// sites together with this string.
				throw new Error(
					`timed out after ${timeoutMs}ms waiting for test-suite lock held by ${describeOwner(owner)}`,
				);
			}
			if (now - lastHeartbeat >= heartbeatIntervalMs) {
				lastHeartbeat = now;
				log(`waiting for test-suite lock held by ${describeOwner(owner)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}
}
