/** Cross-process mutual exclusion for the machine-global instance registry. */

import * as fs from "node:fs";
import { randomInt } from "node:crypto";
import * as path from "node:path";

import { incrementDegradationCount } from "./degradation-ledger.js";

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 500;
const LOCK_MIN_BACKOFF_MS = 5;
const LOCK_MAX_BACKOFF_MS = 25;

function lockPath(target: string): string {
	return `${target}.lock`;
}

function ownerPid(lock: string): number | undefined {
	try {
		const pid = Number(fs.readFileSync(lock, "utf8").trim().split(/\s+/)[0]);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isPidAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
	}
}

function staleLock(lock: string): boolean {
	try {
		const stat = fs.statSync(lock);
		if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;
		const pid = ownerPid(lock);
		return pid !== undefined && !isPidAlive(pid);
	} catch {
		return false;
	}
}

function recordLockTimeout(target: string): void {
	incrementDegradationCount({
		kind: "instance-registry-lock-timeout",
		subject: path.resolve(target),
		reason: `lock acquisition exhausted for ${path.basename(target)}`,
	});
}

function backoffMs(): number {
	return randomInt(LOCK_MIN_BACKOFF_MS, LOCK_MAX_BACKOFF_MS + 1);
}

function backoff(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs());
}

function ownsLock(lock: string): boolean {
	return ownerPid(lock) === process.pid;
}

async function releaseLock(lock: string): Promise<void> {
	// Residual TOCTOU: ownership and unlink are separate syscalls, so a stale
	// takeover can still replace the lock between them.
	if (ownsLock(lock)) await fs.promises.unlink(lock).catch(() => {});
}

function releaseLockSync(lock: string): void {
	if (!ownsLock(lock)) return;
	try {
		fs.unlinkSync(lock);
	} catch {
		// A stale takeover may have displaced the lock after ownership was read.
	}
}

function takeOverStale(lock: string): void {
	if (!staleLock(lock)) return;
	const displaced = `${lock}.stale-${process.pid}-${Date.now()}`;
	try {
		fs.renameSync(lock, displaced);
		fs.unlinkSync(displaced);
	} catch {
		// Another owner may have released or taken over it first.
	}
}

function isLockContention(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EEXIST" || code === "EPERM" || code === "EBUSY";
}

export async function withInstanceRegistryLock<T>(
	target: string,
	op: () => Promise<T>,
): Promise<T | undefined> {
	const lock = lockPath(target);
	const deadline = Date.now() + LOCK_WAIT_MS;
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	while (Date.now() <= deadline) {
		try {
			await fs.promises.writeFile(lock, `${process.pid} ${Date.now()}\n`, {
				flag: "wx",
			});
		} catch (error) {
			if (!isLockContention(error)) throw error;
			takeOverStale(lock);
			if (Date.now() <= deadline)
				await new Promise((resolve) => setTimeout(resolve, backoffMs()));
			continue;
		}
		try {
			return await op();
		} finally {
			await releaseLock(lock);
		}
	}
	recordLockTimeout(target);
	return undefined;
}

export function withInstanceRegistryLockSync<T>(
	target: string,
	op: () => T,
): T | undefined {
	const lock = lockPath(target);
	const deadline = Date.now() + LOCK_WAIT_MS;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	while (Date.now() <= deadline) {
		try {
			fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
			try {
				return op();
			} finally {
				releaseLockSync(lock);
			}
		} catch (error) {
			if (!isLockContention(error)) throw error;
			takeOverStale(lock);
			if (Date.now() <= deadline) backoff();
		}
	}
	recordLockTimeout(target);
	return undefined;
}
