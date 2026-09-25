import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ATOMIC_STAGE_SWEEP_MAX_ENTRIES,
	sweepAtomicWriteStages,
} from "../../clients/instance-reaper.js";

const cleanup: string[] = [];

function makeDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-stage-gc-"));
	cleanup.push(dir);
	return dir;
}

function stage(dir: string, name: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, "staging");
	return file;
}

function findDeadPid(): number {
	for (let candidate = 999_983; candidate > 1_000; candidate -= 7_919) {
		try {
			process.kill(candidate, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
		}
	}
	throw new Error("could not find a definitively dead pid");
}

afterEach(() => {
	while (cleanup.length > 0) {
		fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
	}
});

describe("sweepAtomicWriteStages (#1228)", () => {
	it("reaps a genuine dead-pid orphan in the current shape", async () => {
		const dir = makeDir();
		const orphan = stage(dir, `state.json.tmp-${findDeadPid()}-2-7`);

		const result = await sweepAtomicWriteStages([dir]);

		expect(result.removed).toBe(1);
		expect(fs.existsSync(orphan)).toBe(false);
	});

	it("preserves legacy suffixes and live foreign owners", async () => {
		const dir = makeDir();
		const liveForeignPid = process.ppid;
		expect(liveForeignPid).toBeGreaterThan(0);
		expect(liveForeignPid).not.toBe(process.pid);
		const liveForeign = stage(dir, `state.json.tmp-${liveForeignPid}-3-9`);
		const legacy = [
			stage(dir, "backup.tmp-2023-11"),
			stage(dir, "state.json.tmp-41002"),
			stage(dir, "state.json.tmp-41002-7"),
		];
		const currentProcess = stage(dir, `state.json.tmp-${process.pid}-0-99`);
		const unrelated = stage(dir, "state.json.tmp-42001-3-9-extra");
		const ordinary = stage(dir, "state.json");

		// No liveness override: this exercises the real ESRCH-only probe.
		await sweepAtomicWriteStages([dir]);

		expect(fs.existsSync(liveForeign)).toBe(true);
		expect(legacy.every((file) => fs.existsSync(file))).toBe(true);
		expect(fs.existsSync(currentProcess)).toBe(true);
		expect(fs.existsSync(unrelated)).toBe(true);
		expect(fs.existsSync(ordinary)).toBe(true);
	});

	it("preserves leading-zero names that are not writer-emitted staging files", async () => {
		const dir = makeDir();
		const leadingZeroPid = stage(dir, "x.tmp-000123-02-03");
		const leadingZeroComponents = stage(dir, "backup.tmp-01-02-03");

		await sweepAtomicWriteStages([dir], { isPidAlive: () => false });

		expect(fs.existsSync(leadingZeroPid)).toBe(true);
		expect(fs.existsSync(leadingZeroComponents)).toBe(true);
	});

	it("does not remove directories or malformed/non-atomic names", async () => {
		const dir = makeDir();
		const namedDirectory = path.join(dir, "nested.tmp-43001");
		fs.mkdirSync(namedDirectory);
		const malformed = [
			stage(dir, "state.tmp-43001-1-2-3"),
			stage(dir, "state.tmp-43001-"),
			stage(dir, "state.TMP-43001"),
		];

		await sweepAtomicWriteStages([dir], { isPidAlive: () => false });

		expect(fs.existsSync(namedDirectory)).toBe(true);
		expect(malformed.every((file) => fs.existsSync(file))).toBe(true);
	});

	it("stops after the configured bounded number of directory entries", async () => {
		const dir = makeDir();
		const files = Array.from({ length: 3 }, (_, i) =>
			stage(dir, `state-${i}.tmp-4400${i}-0-${i}`),
		);

		const result = await sweepAtomicWriteStages([dir], {
			maxEntries: 2,
			isPidAlive: () => false,
		});

		expect(result.scanned).toBe(2);
		expect(result.removed).toBe(2);
		expect(result.truncated).toBe(true);
		expect(files.filter((file) => fs.existsSync(file))).toHaveLength(1);
	});

	it("fails closed for missing directories and invalid owner pids", async () => {
		const dir = makeDir();
		const zeroPid = stage(dir, "state.tmp-0");
		const hugePid = stage(dir, "state.tmp-999999999999999999999");

		await expect(
			sweepAtomicWriteStages([path.join(dir, "missing"), dir], {
				isPidAlive: () => false,
			}),
		).resolves.toMatchObject({ directories: 2, removed: 0 });
		expect(fs.existsSync(zeroPid)).toBe(true);
		expect(fs.existsSync(hugePid)).toBe(true);
		expect(ATOMIC_STAGE_SWEEP_MAX_ENTRIES).toBeGreaterThan(0);
	});
});
