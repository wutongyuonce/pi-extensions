import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireBoundedPidFileLock } from "../../clients/bounded-pid-file-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("acquireBoundedPidFileLock", () => {
	it("defaults to throwing when contention policy is omitted", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		const releaseFirst = acquireBoundedPidFileLock(lockPath, {
			waitMs: 10,
			retryMs: 1,
			timeoutMessage: "first lock timed out",
		});
		expect(() =>
			acquireBoundedPidFileLock(lockPath, {
				waitMs: 0,
				retryMs: 1,
				timeoutMessage: "second lock timed out",
			}),
		).toThrow("second lock timed out");
		releaseFirst();
	});

	it("logs and skips after two seconds without disturbing a concurrent process's write", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		const statePath = path.join(dir, "state.json");
		const fixture = fileURLToPath(
			new URL("../fixtures/bounded-pid-lock-holder.mjs", import.meta.url),
		);
		const holder = spawn(process.execPath, [fixture, lockPath, statePath], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.stdout.once("data", (chunk) => {
				if (String(chunk).includes("locked")) resolve();
				else reject(new Error(`unexpected holder output: ${String(chunk)}`));
			});
		});
		const logContention = vi.fn();

		expect(
			acquireBoundedPidFileLock(lockPath, {
				waitMs: 2_000,
				retryMs: 10,
				timeoutMessage: "second lock timed out",
				onContention: "skip-log",
				logContention,
			}),
		).toBeNull();
		expect(logContention).toHaveBeenCalledOnce();
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
			);
		});
		expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
			writer: "first",
		});
	});
});
