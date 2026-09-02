/**
 * Regression coverage for #2346: a scraped/minified text file whose NAME
 * carries no generated marker (`.html`) must classify as generated from its
 * content shape alone, and `dispatchForFile` must short-circuit it to zero
 * diagnostics while emitting a bounded `dispatch_skipped_generated` record.
 *
 * Drives the REAL `createDispatchContext` → `dispatchForFile` seam with a
 * real file on disk (the content-shape decision runs on the 4096-byte prefix
 * `createDispatchContext` already reads for role detection — no extra I/O).
 * `logLatency` is mocked at the module boundary only (the #1742 real-sinks
 * rule's exception: the mechanism under test here is the phase RECORD's
 * shape, which a real log write hides under `isTestMode()`).
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LatencyEntry } from "../../../clients/latency-logger.js";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	RunnerRegistry,
	dispatchForFile as runDispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerGroup } from "../../../clients/dispatch/types.js";
import {
	MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD,
	_resetGeneratedArtifactCaches,
} from "../../../clients/generated-artifacts.js";
import { createMockRunner } from "../../mocks/runner-factory.js";

const { latencyEntries } = vi.hoisted(() => ({
	latencyEntries: [] as LatencyEntry[],
}));

vi.mock("../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

let tmpDir: string;
let minifiedFile: string;
let registry: RunnerRegistry;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-2346-"));
	// A saved/scraped page: a handful of multi-KB lines, no generated name,
	// no generated-code banner.
	const longLine = "a".repeat(10_000);
	minifiedFile = path.join(tmpDir, "tmp-google-page.html");
	fs.writeFileSync(minifiedFile, `${longLine}\n${"b".repeat(10_000)}\n`);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
	latencyEntries.length = 0;
	resetDegradationLedger();
	clearCoverageNoticeState();
	_resetGeneratedArtifactCaches();
	registry = new RunnerRegistry();
});

describe("dispatch skips machine-emitted text via content shape (refs #2346)", () => {
	it("classifies the file generated from content shape alone and dispatch returns zero diagnostics", async () => {
		// A diagnostic-producing runner that MUST NOT run if the short-circuit
		// fires; pre-fix the file classified "source" and this runner ran,
		// returning one finding.
		let runCount = 0;
		registry.register(
			createMockRunner({
				id: "would-report",
				appliesTo: [],
				runResult: {
					status: "succeeded",
					diagnostics: [
						{
							id: "html-finding",
							message: "must never run",
							filePath: minifiedFile,
							severity: "warning",
							semantic: "warning",
							tool: "would-report",
						},
					],
					semantic: "warning",
				},
				when: () => {
					runCount += 1;
					return true;
				},
			}),
		);

		const ctx = createDispatchContext(
			minifiedFile,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
		);

		expect(ctx.fileRole).toBe("generated");
		expect(ctx.generatedEvidence).toBe("line-shape");
		expect(ctx.generatedLineShapeMean).toBeGreaterThan(
			MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD,
		);

		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["would-report"] },
		];
		const result = await runDispatchForFile(ctx, groups, registry);

		expect(result.diagnostics).toEqual([]);
		expect(result.hasBlockers).toBe(false);
		expect(runCount).toBe(0);
	});

	it("emits a bounded dispatch_skipped_generated phase record with evidence tier and measured statistic", async () => {
		const ctx = createDispatchContext(
			minifiedFile,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
		);
		const groups: RunnerGroup[] = [{ mode: "all", runnerIds: [] }];

		await runDispatchForFile(ctx, groups, registry);
		const first = latencyEntries.filter(
			(entry) => entry.phase === "dispatch_skipped_generated",
		);
		expect(first).toHaveLength(1);
		expect(first[0].filePath).toBe(ctx.filePath);
		expect(first[0].metadata?.evidence).toBe("line-shape");
		expect(first[0].metadata?.lineShapeMean).toBeGreaterThan(
			MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD,
		);

		// Repeat dispatches of the same file: the phase record is deduped to
		// one per file (#2346 no-spam requirement).
		await runDispatchForFile(ctx, groups, registry);
		await runDispatchForFile(ctx, groups, registry);
		const afterRepeats = latencyEntries.filter(
			(entry) => entry.phase === "dispatch_skipped_generated",
		);
		expect(afterRepeats).toHaveLength(1);

		// #2348 review F3: a generated skip is healthy behavior, NOT a
		// degradation — it must never appear in the ledger, where it would
		// consume a bounded kind slot and surface under /lens-perf
		// "Degradations". The phase record above is the observability record.
		const skippedGroup = getDegradationSummary().find(
			(group) => group.kind === "dispatch-skipped-generated",
		);
		expect(skippedGroup).toBeUndefined();
	});
});
