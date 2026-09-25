import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	collectLatencyPerformance,
	MAX_PERF_PHASE_SAMPLES,
	resolveLogByteBudget,
} from "../../clients/performance-report.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

const MAX_SYNC_BLOCK_MS = 75;

// Size the fixture to the window production actually reads, so the parse this
// measures can't silently shrink if the rotation threshold or its default moves.
const WINDOW_BYTES = resolveLogByteBudget();

let tempDir: string;
let logPath: string;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-perf-occupancy-"));
	logPath = path.join(tempDir, "latency.log");
	const chunk = Array.from(
		{ length: 1000 },
		(_, index) =>
			`${JSON.stringify({
				type: "phase",
				phase: "occupancy-fixture",
				filePath: "fixture.ts",
				durationMs: ((index * 7919) % 10_000) + 1,
				pid: 7,
				ts: "2026-01-01T00:00:00.000Z",
			})}\n`,
	).join("");
	fs.writeFileSync(
		logPath,
		chunk.repeat(Math.ceil(WINDOW_BYTES / Buffer.byteLength(chunk))),
	);
}, 30_000);

afterAll(() => {
	removeTempDirSync(tempDir);
});

it(
	"keeps /lens-perf log parsing below the event-loop occupancy budget",
	{
		retry: 2,
		timeout: 30_000,
	},
	async () => {
		let retainedSamples = 0;
		const maxBlock = await measureMaxSyncBlockMs(async () => {
			const report = await collectLatencyPerformance({
				logPath,
				processId: 7,
				sessionStartedAt: 0,
			});
			retainedSamples = report.logWindow.sampleCount;
			// Fail loudly if the fixture no longer fills the window — otherwise this
			// keeps passing while measuring a parse it was never meant to.
			expect(report.windowBytes).toBe(WINDOW_BYTES);
			expect(report.windowTruncated).toBe(true);
		});

		expect(retainedSamples).toBe(MAX_PERF_PHASE_SAMPLES);
		expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
	},
);
