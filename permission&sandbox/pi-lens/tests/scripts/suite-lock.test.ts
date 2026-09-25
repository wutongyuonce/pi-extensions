/**
 * Tests for scripts/lib/suite-lock.mjs (#1101): the machine-wide test-suite
 * lock core (acquire/release/contention/stale-PID takeover). Kept as a pure
 * .mjs module specifically so this can import it directly without a build
 * step and without spawning scripts/with-test-lock.mjs as a child process.
 *
 * Uses an explicit `lockPath` under `fs.mkdtemp()` (never the real
 * `~/.pi-lens`) and short poll/heartbeat intervals via options so the
 * contention/stale-takeover cases run fast.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireTestLock,
	isProcessAlive,
} from "../../scripts/lib/suite-lock.mjs";

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-test-lock-"));
	lockPath = path.join(tmpDir, "test-suite.lock");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isProcessAlive", () => {
	it("reports the current process as alive", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("reports a PID that cannot possibly be live as dead", () => {
		// A PID this large will not exist on any real system.
		expect(isProcessAlive(999_999_999)).toBe(false);
	});
});

describe("acquireTestLock — acquire/release", () => {
	it("creates the lock file atomically and removes it on release", async () => {
		const lock = await acquireTestLock({ lockPath });
		expect(fs.existsSync(lockPath)).toBe(true);

		const body = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		expect(body.pid).toBe(process.pid);
		expect(typeof body.startedIso).toBe("string");
		expect(() => new Date(body.startedIso).toISOString()).not.toThrow();

		await lock.release();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("release is idempotent (safe to call more than once)", async () => {
		const lock = await acquireTestLock({ lockPath });
		await lock.release();
		await expect(lock.release()).resolves.toBeUndefined();
	});

	it("creates parent directories as needed", async () => {
		const nestedPath = path.join(tmpDir, "nested", "dir", "test-suite.lock");
		const lock = await acquireTestLock({ lockPath: nestedPath });
		expect(fs.existsSync(nestedPath)).toBe(true);
		await lock.release();
	});
});

describe("acquireTestLock — stale-PID takeover", () => {
	it("takes over immediately when the recorded PID is confirmed dead (no age/timeout wait)", async () => {
		// Simulate a lock left behind by a process that no longer exists —
		// fresh mtime (not aged out by the mtime fallback), so the ONLY reason
		// this can be taken over is the dead-PID check itself.
		await fsp.mkdir(path.dirname(lockPath), { recursive: true });
		await fsp.writeFile(
			lockPath,
			JSON.stringify({
				pid: 999_999_999,
				startedIso: new Date().toISOString(),
			}),
		);

		const start = Date.now();
		const lock = await acquireTestLock({
			lockPath,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 10_000,
			timeoutMs: 5_000,
		});
		const elapsed = Date.now() - start;

		// Should recover well within one heartbeat/timeout interval — this is
		// an immediate takeover, not a timed-out wait.
		expect(elapsed).toBeLessThan(2_000);

		const body = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		expect(body.pid).toBe(process.pid);

		await lock.release();
	});

	it("takes over an unreadable/corrupt lock once it ages past staleMaxAgeMs", async () => {
		await fsp.mkdir(path.dirname(lockPath), { recursive: true });
		await fsp.writeFile(lockPath, "not valid json");
		// Back-date the mtime so the mtime-based fallback considers it stale.
		const old = new Date(Date.now() - 60_000);
		await fsp.utimes(lockPath, old, old);

		const lock = await acquireTestLock({
			lockPath,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 10_000,
			timeoutMs: 5_000,
			staleMaxAgeMs: 1_000,
		});

		const body = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		expect(body.pid).toBe(process.pid);
		await lock.release();
	});
});

describe("acquireTestLock — transient EBUSY/EPERM on the create itself", () => {
	it("retries into the contended path and eventually acquires when open('wx') rejects with EBUSY once", async () => {
		// #1112 review round 3: reproduces the real Windows race — a lock file
		// JUST unlinked by another process's release() can still transiently
		// reject a fresh `open(path, "wx")` with EBUSY/EPERM before the OS
		// fully drops the deleted file's handle. Injected deterministically via
		// vi.spyOn on the shared "node:fs/promises" module object: Node's ESM
		// module registry is process-wide, so this spy is visible to
		// suite-lock.mjs's own `import fsp from "node:fs/promises"` binding —
		// no separate fs seam/DI needed. Rejects exactly once for THIS
		// lockPath's "wx" open, then calls through to the real implementation,
		// so the underlying lock semantics are exercised for real (no stubbed
		// success).
		const realOpen = fsp.open.bind(fsp);
		let rejectedOnce = false;
		const openSpy = vi
			.spyOn(fsp, "open")
			.mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
				const [target, flags] = args;
				if (!rejectedOnce && target === lockPath && flags === "wx") {
					rejectedOnce = true;
					const err = new Error(
						"EBUSY: resource busy or locked, open '" + lockPath + "'",
					) as NodeJS.ErrnoException;
					err.code = "EBUSY";
					throw err;
				}
				return realOpen(...args);
			});

		try {
			const lock = await acquireTestLock({
				lockPath,
				pollIntervalMs: 10,
				heartbeatIntervalMs: 10_000,
				timeoutMs: 5_000,
			});

			// Proves the retry actually happened: the spy was invoked at least
			// twice for this path (the rejected attempt, then the successful
			// one) rather than acquireTestLock crashing out on the first EBUSY.
			expect(rejectedOnce).toBe(true);
			const callsForThisPath = openSpy.mock.calls.filter(
				(call) => call[0] === lockPath,
			);
			expect(callsForThisPath.length).toBeGreaterThanOrEqual(2);

			const body = JSON.parse(fs.readFileSync(lockPath, "utf8"));
			expect(body.pid).toBe(process.pid);

			await lock.release();
		} finally {
			openSpy.mockRestore();
		}
	});
});

describe("acquireTestLock — contention", () => {
	it("serializes two concurrent acquisitions: the second waits until the first releases", async () => {
		const events: string[] = [];
		const heartbeats: string[] = [];

		const first = await acquireTestLock({ lockPath, pollIntervalMs: 10 });
		events.push("first-acquired");

		let secondAcquired = false;
		const secondPromise = acquireTestLock({
			lockPath,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 20,
			log: (msg) => heartbeats.push(msg),
		}).then((lock) => {
			secondAcquired = true;
			events.push("second-acquired");
			return lock;
		});

		// Give the second acquisition several poll cycles to prove it is
		// actually blocked, not racing in immediately.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(secondAcquired).toBe(false);
		expect(heartbeats.length).toBeGreaterThan(0);
		heartbeats.forEach((line) => {
			expect(line).toContain(`PID ${process.pid}`);
		});

		events.push("first-released");
		await first.release();

		const second = await secondPromise;
		expect(secondAcquired).toBe(true);
		// Order proves serialization: the first must fully release before the
		// second observes acquisition.
		expect(events).toEqual([
			"first-acquired",
			"first-released",
			"second-acquired",
		]);

		await second.release();
	});

	it("throws a legible timeout error when timeoutMs is exceeded without acquiring", async () => {
		const first = await acquireTestLock({ lockPath, pollIntervalMs: 10 });
		try {
			await expect(
				acquireTestLock({
					lockPath,
					pollIntervalMs: 10,
					heartbeatIntervalMs: 10_000,
					timeoutMs: 50,
				}),
			).rejects.toThrow(/timed out after 50ms waiting for test-suite lock/);
		} finally {
			await first.release();
		}
	});
});
