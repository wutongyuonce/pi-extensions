/**
 * Regression guard for #525 (test hermeticity for ~/.pi-lens machine-global
 * state, the same class #515 fixed for config.json).
 *
 * Uses the REAL (unmocked) `getGlobalPiLensDir` — deliberately does NOT mock
 * `clients/file-utils.js` like tests/clients/instance-registry.test.ts does,
 * so this test proves the actual env-var routing end to end: every writer
 * under `~/.pi-lens` goes through `getGlobalPiLensDir()`, which now respects
 * `PI_LENS_HOME`. Dogfooding caught this live 2026-07-11: a test-fixture
 * instance (`Temp/pi-lens-turn-summary-*` projectRoot) survived in the
 * developer's REAL `~/.pi-lens/instances.json` for ~17h because tests
 * exercising `registerInstance` had no override and wrote straight into the
 * real homedir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const realGlobalDir = path.join(os.homedir(), ".pi-lens");
const realRegistryPath = path.join(realGlobalDir, "instances.json");

describe("machine-global writers route through PI_LENS_HOME, never the real homedir", () => {
	let overrideDir: string;

	beforeEach(() => {
		overrideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-home-override-"),
		);
		process.env.PI_LENS_HOME = overrideDir;
	});

	afterEach(() => {
		removeTempDirSync(overrideDir);
		delete process.env.PI_LENS_HOME;
	});

	it("getGlobalPiLensDir resolves to PI_LENS_HOME", async () => {
		const { getGlobalPiLensDir } = await import("../../clients/file-utils.js");
		expect(getGlobalPiLensDir()).toBe(path.resolve(overrideDir));
	});

	it("registerInstance writes instances.json under PI_LENS_HOME, never under the real homedir", async () => {
		const realHomeExistedBefore = fs.existsSync(realRegistryPath);
		const realHomeMtimeBefore = realHomeExistedBefore
			? fs.statSync(realRegistryPath).mtimeMs
			: undefined;

		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/some/override-routed/project");

		const overriddenPath = path.join(overrideDir, "instances.json");
		expect(fs.existsSync(overriddenPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(overriddenPath, "utf-8"));
		expect(parsed.instances).toHaveLength(1);
		expect(parsed.instances[0].projectRoot).toContain(
			"override-routed/project",
		);

		// The real ~/.pi-lens/instances.json must be untouched: either it still
		// doesn't exist, or (if a real pi-lens session happens to run on this
		// machine concurrently) its mtime did not change from this test's write.
		if (realHomeExistedBefore) {
			expect(fs.statSync(realRegistryPath).mtimeMs).toBe(realHomeMtimeBefore);
		} else {
			expect(fs.existsSync(realRegistryPath)).toBe(false);
		}
	});

	it("deregisterInstance operates only on the PI_LENS_HOME-scoped registry", async () => {
		const { registerInstance, deregisterInstance, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/dereg/project");
		expect(await readInstanceRegistry()).toHaveLength(1);

		deregisterInstance();
		expect(await readInstanceRegistry()).toHaveLength(0);

		// Confirm it operated under the override, not the real homedir dir.
		expect(fs.existsSync(path.join(overrideDir, "instances.json"))).toBe(true);
	});
});
