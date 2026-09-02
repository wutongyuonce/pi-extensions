/**
 * Middle-of-pipe wiring test for #1448 model/provider attribution.
 *
 * file-utils.test.ts covers the appendToWorklog ENDPOINT (does the write
 * redact/shape identity correctly) and runtime-coordinator.test.ts covers
 * the RuntimeCoordinator ENDPOINT (does setTelemetryIdentity derive/track
 * correctly). Neither exercises the seam between them: createDispatchContext
 * threading telemetryModel/telemetryProvider into a DispatchContext, and the
 * real (unmocked) dispatchForFile reading ctx.telemetryModel/telemetryProvider
 * to build the worklogIdentity it hands to appendToWorklog.
 *
 * integration.test.ts drives dispatchLintWithResult but mocks dispatchForFile
 * out entirely (see clients/dispatch/dispatcher.js mock at the top of that
 * file), so a severed identity thread inside dispatchForFile itself would
 * pass every existing suite silently. This test uses the REAL
 * createDispatchContext + dispatchForFile (dispatchLintWithResult's own
 * implementation, minus the module-scoped sessionRunnerRegistry) so a
 * severance at that seam goes red here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../clients/fix-worklog.js", () => ({
	appendToWorklog: vi.fn(),
}));

import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { appendToWorklog } from "../../../clients/fix-worklog.js";
import type { RunnerGroup } from "../../../clients/dispatch/types.js";
import { createMockRunner } from "../../mocks/runner-factory.js";

describe("dispatcher worklog identity wiring (#1448)", () => {
	let registry: RunnerRegistry;

	beforeEach(() => {
		registry = new RunnerRegistry();
		vi.mocked(appendToWorklog).mockReset();
	});

	it("threads telemetryModel/telemetryProvider from createDispatchContext through the real dispatchForFile into appendToWorklog", async () => {
		registry.register(
			createMockRunner({
				id: "fixable-warning-runner",
				appliesTo: ["jsts"],
				runResult: {
					status: "succeeded",
					diagnostics: [
						{
							id: "fixable-1",
							message: "Unused import",
							filePath: "test.ts",
							line: 1,
							severity: "warning",
							semantic: "warning",
							tool: "fixable-warning-runner",
							fixable: true,
						},
					],
					semantic: "warning",
				},
			}),
		);

		const ctx = createDispatchContext(
			"test.ts",
			"/project",
			{ getFlag: () => false },
			new FactStore(),
			false, // blockingOnly=false so the warning survives categorization
			undefined, // modifiedRanges
			undefined, // projectRoot
			undefined, // writeIndex
			"claude-sonnet-4-5", // telemetryModel — this is the identity under test
			"anthropic", // telemetryProvider
		);
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["fixable-warning-runner"] },
		];

		await dispatchForFile(ctx, groups, registry);

		await vi.waitFor(() => {
			expect(appendToWorklog).toHaveBeenCalled();
		});

		const call = vi.mocked(appendToWorklog).mock.calls.find(
			(args) => args[2] === false, // the fixable-warnings append, not the fixed-items one
		);
		expect(call).toBeDefined();
		expect(call?.[3]).toEqual({
			model: "claude-sonnet-4-5",
			provider: "anthropic",
		});
	});
});
