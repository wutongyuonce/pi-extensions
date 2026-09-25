import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	withInstanceRegistryLock,
	withInstanceRegistryLockSync,
} from "../../clients/instance-registry-lock.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];

const testTimeoutScale = (() => {
	const parsed = Number(process.env.PI_LENS_TEST_TIMEOUT_SCALE ?? "1");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("instance registry lock", () => {
	it("takes over an old lock owned by a dead pid", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		const lock = `${target}.lock`;
		fs.writeFileSync(lock, "999999 0\n");
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(lock, old, old);

		await expect(
			withInstanceRegistryLock(target, async () => "acquired"),
		).resolves.toBe("acquired");
		expect(fs.existsSync(lock)).toBe(false);
	});

	it("records one bounded degradation when contention exhausts the wait", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${target}.lock`, `${process.pid} ${Date.now()}\n`);

		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		expect(getDegradationSummary()).toContainEqual(
			expect.objectContaining({
				kind: "instance-registry-lock-timeout",
				count: 2,
				latestReasons: [
					expect.objectContaining({ subject: path.resolve(target) }),
				],
			}),
		);
		fs.unlinkSync(`${target}.lock`);
	});

	it("does not reclaim a fresh empty lock", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		fs.writeFileSync(`${target}.lock`, "");

		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		expect(fs.existsSync(`${target}.lock`)).toBe(true);
		fs.unlinkSync(`${target}.lock`);
	});

	it("keeps a replacement lock when the displaced holder releases", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		const lock = `${target}.lock`;

		expect(
			withInstanceRegistryLockSync(target, () => {
				fs.writeFileSync(lock, "999999 0\n");
				return "acquired";
			}),
		).toBe("acquired");
		expect(fs.readFileSync(lock, "utf8")).toBe("999999 0\n");
		fs.unlinkSync(lock);
	});

	it("excludes async acquisition while the sync path owns the lock", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		let contender: Promise<string | undefined> | undefined;

		expect(
			withInstanceRegistryLockSync(target, () => {
				contender = withInstanceRegistryLock(target, async () => "async");
				const end = Date.now() + 50;
				while (Date.now() < end) {}
				return "sync";
			}),
		).toBe("sync");
		expect(contender).toBeDefined();
		expect(await contender!).toBe("async");
	});

	it("holds the lock against a child-process contender during the sync body", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		const marker = path.join(dir, "sync-body.marker");
		const lockModule = pathToFileURL(
			path.resolve("clients/instance-registry-lock.js"),
		).href;
		const childScript = `import(${JSON.stringify(lockModule)}).then(({ withInstanceRegistryLockSync }) => { const result = withInstanceRegistryLockSync(process.argv[1], () => "acquired"); process.stdout.write(result === undefined ? "blocked" : result); });`;

		expect(
			withInstanceRegistryLockSync(target, () => {
				fs.writeFileSync(marker, "sync body reached\n");
				return execFileSync(
					process.execPath,
					["--input-type=module", "-e", childScript, target],
					{
						encoding: "utf8",
						cwd: process.cwd(),
						timeout: 2_000 * testTimeoutScale,
						windowsHide: true,
					},
				).trim();
			}),
		).toBe("blocked");
		expect(fs.readFileSync(marker, "utf8")).toBe("sync body reached\n");
	});
});
