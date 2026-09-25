import { describe, expect, it } from "vitest";
import { createFileTime } from "../../clients/file-time.js";

// #2402: partial-apply's pre-write rejection is the first FileTime.withLock
// caller whose fn can REJECT. The lock map's stored promise must never turn
// that into an unhandled rejection, and a waiter must still resume.
describe("FileTime.withLock rejection handling", () => {
	it("does not leak an unhandled rejection and still releases the lock", async () => {
		const fileTime = createFileTime("partial-apply-lock-test");
		let unhandled = false;
		const onUnhandled = (): void => {
			unhandled = true;
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			let holderStarted!: () => void;
			let releaseHolder!: () => void;
			const holderReady = new Promise<void>((resolve) => {
				holderStarted = resolve;
			});
			const release = new Promise<void>((resolve) => {
				releaseHolder = resolve;
			});
			const holder = fileTime.withLock("/locked/file.ts", async () => {
				holderStarted();
				await release;
				throw new Error("rejection inside the lock");
			});
			await holderReady;
			let waiterRan = false;
			const waiter = fileTime.withLock("/locked/file.ts", async () => {
				waiterRan = true;
			});
			releaseHolder();
			await expect(holder).rejects.toThrow("rejection inside the lock");
			await waiter;
			expect(waiterRan).toBe(true);
			expect(unhandled).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
