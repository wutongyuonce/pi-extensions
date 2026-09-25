import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
});

describe("instance registry cross-process writer exclusion", () => {
	it("retains every registration across real node writer races", async () => {
		const worker = path.resolve(
			"tests/fixtures/instance-registry-race-worker.mjs",
		);
		const rounds = 12;
		const writers = 6;
		const lost: number[] = [];

		for (let round = 0; round < rounds; round++) {
			const home = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-registry-race-"),
			);
			tempDirs.push(home);
			const barrier = path.join(home, `barrier-${round}`);
			const children = Array.from({ length: writers }, (_, writer) =>
				execFileAsync(
					process.execPath,
					[worker, home, barrier, `/race/${round}/${writer}`],
					{
						cwd: process.cwd(),
						env: { ...process.env, PI_LENS_HOME: home },
						windowsHide: true,
					},
				),
			);
			fs.writeFileSync(barrier, "go\n");
			await Promise.all(children);
			const parsed = JSON.parse(
				fs.readFileSync(path.join(home, "instances.json"), "utf8"),
			);
			const count = parsed.instances.length;
			if (count !== writers) lost.push(writers - count);
		}

		// Pre-lock probe result: 9/72 registrations lost at N=6 over 12 rounds.
		// Fixed result: 0/72 registrations lost. This bound rejects any loss.
		expect(lost, `lost registrations by round: ${lost.join(", ")}`).toEqual([]);
	}, 30_000);
});
