// Type declarations for suite-lock.mjs (untyped .mjs imported from .ts tests).
// #1101.

export function getLockPath(): string;

export function isProcessAlive(pid: number): boolean;

export interface AcquireTestLockOptions {
	lockPath?: string;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	timeoutMs?: number;
	log?: (message: string) => void;
	staleMaxAgeMs?: number;
}

export interface TestLockHandle {
	lockPath: string;
	release: () => Promise<void>;
}

export function acquireTestLock(
	options?: AcquireTestLockOptions,
): Promise<TestLockHandle>;
