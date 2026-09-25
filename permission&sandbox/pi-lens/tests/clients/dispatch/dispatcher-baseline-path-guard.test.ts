/**
 * Round-2 coverage for #2489: the delta-baseline key in `dispatchForFile`
 * (`clients/dispatch/dispatcher.ts`) rests entirely on `ctx.filePath` being
 * absolute — a guarantee `createDispatchContext` (the sole real constructor)
 * enforces via `resolveRunnerPath`, but that nothing enforced AT THIS SEAM.
 * A hand-built `DispatchContext` carrying a relative `filePath` (the only way
 * to violate the #2016 invariant — test scaffolding or a future caller
 * regression) used to silently key the baseline under a value the
 * constructor could never produce. This mirrors the sibling guard
 * `recordEntitySnapshotDiff` already enforces for the review-graph
 * entity-snapshot seam (`clients/review-graph/service.ts`, #2477): reject
 * visibly via `recordDegradationOnce` and skip the read/write, rather than
 * compute one under an unreachable key.
 *
 * Also pins the `dispatch_complete` observability record's `baselineHit` /
 * `baselineWarningCount` metadata fields (#2489 round 2 review F1):
 * `dispatch_start` fires BEFORE the baseline read (`metadata: { groupCount,
 * kind, runners }`) and cannot carry either value, so `dispatch_complete` is
 * the only place a latency.log consumer can distinguish a baseline HIT (a
 * prior snapshot was read this session) from a MISS.
 *
 * `logLatency` is mocked at the module boundary only (the #1742 real-sinks
 * rule's exception, matching `dispatch-generated-skip.test.ts`): the
 * mechanism under test is the record's SHAPE, which a real log write hides
 * under `isTestMode()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../../clients/latency-logger.js";
import {
	createDispatchContext,
	RunnerRegistry,
	dispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type {
	DispatchContext,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
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

function warningRunner(id: string) {
	return createMockRunner({
		id,
		appliesTo: ["jsts"],
		runResult: {
			status: "succeeded",
			diagnostics: [
				{
					id: "warn-1",
					message: "warn",
					filePath: "test.ts",
					severity: "warning",
					semantic: "warning",
					tool: id,
				},
			],
			semantic: "warning",
		},
	});
}

function dispatchCompleteEntry(): LatencyEntry | undefined {
	return latencyEntries.find(
		(e) => e.type === "tool_result" && e.result === "dispatch_complete",
	);
}

describe("dispatchForFile baseline-path guard (#2489 round 2)", () => {
	let registry: RunnerRegistry;

	beforeEach(() => {
		latencyEntries.length = 0;
		resetDegradationLedger();
		registry = new RunnerRegistry();
	});

	it("rejects a non-absolute ctx.filePath with a visible degradation record and skips the baseline read/write", async () => {
		registry.register(warningRunner("reporter"));
		const facts = new FactStore();
		const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];

		// The only way to violate the #2016 invariant: `createDispatchContext`
		// itself always normalizes, so a relative `filePath` can only reach
		// `dispatchForFile` through a hand-built ctx — the same shape #2477's
		// sibling test (`tests/clients/review-graph/session-facts.test.ts`)
		// exercises for `recordEntitySnapshotDiff`.
		const baseCtx = createDispatchContext(
			"test.ts",
			"/project",
			{ getFlag: () => false },
			facts,
		);
		const ctx: DispatchContext = { ...baseCtx, filePath: "relative/test.ts" };

		const result = await dispatchForFile(ctx, groups, registry);

		expect(result.baselineWarningCount).toBe(0);
		const group = getDegradationSummary().find(
			(g) => g.kind === "dispatch-non-absolute-baseline-path",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("relative/test.ts");

		// The write below the read is gated on the same safety check, so no
		// fact was ever written under the unreachable relative key.
		expect(
			facts.hasBoundedSessionFact("session.baseline.relative/test.ts"),
		).toBe(false);

		// A second dispatch under the same spelling must still read as a fresh
		// miss, not a "prior write found" hit.
		const secondResult = await dispatchForFile(ctx, groups, registry);
		expect(secondResult.baselineWarningCount).toBe(0);
		// `recordDegradationOnce` fires at most once per subject.
		const groupAfter = getDegradationSummary().find(
			(g) => g.kind === "dispatch-non-absolute-baseline-path",
		);
		expect(groupAfter?.count).toBe(1);
	});

	it("surfaces baselineHit and baselineWarningCount on the dispatch_complete observability record", async () => {
		registry.register(warningRunner("reporter"));
		const facts = new FactStore();
		const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];
		const ctx = createDispatchContext(
			"test.ts",
			"/project",
			{ getFlag: () => false },
			facts,
		);

		// First dispatch of this file: no prior baseline exists — a MISS.
		await dispatchForFile(ctx, groups, registry);
		const firstComplete = dispatchCompleteEntry();
		expect(firstComplete?.metadata?.baselineHit).toBe(false);
		expect(firstComplete?.metadata?.baselineWarningCount).toBe(0);

		// Second dispatch of the same file: the first dispatch's snapshot
		// (one warning) was persisted as the new baseline — a HIT.
		latencyEntries.length = 0;
		await dispatchForFile(ctx, groups, registry);
		const secondComplete = dispatchCompleteEntry();
		expect(secondComplete?.metadata?.baselineHit).toBe(true);
		expect(secondComplete?.metadata?.baselineWarningCount).toBe(1);
	});
});
