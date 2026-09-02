/** Regression coverage for #2323: CSS must reach ast-grep through the write plan. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchLintDetailed } from "../../../clients/dispatch/integration.js";
import type { LatencyEntry } from "../../../clients/latency-logger.js";
import {
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../support/real-runner-ctx.js";

const { latencyEntries } = vi.hoisted(() => ({
	latencyEntries: [] as LatencyEntry[],
}));

vi.mock("../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

vi.mock("../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv();
});
afterAll(() => env.cleanup());

describe("ast-grep write-plan dispatch", () => {
	it("dispatches a CSS edit to ast-grep-napi and reports no-important", async () => {
		const { filePath } = env.addFile(
			"style.css",
			[".modal {", "  z-index: 9999 !important;", "}", ""].join("\n"),
		);
		const { result, runners } = await dispatchLintDetailed(
			filePath,
			env.cwd,
			{
				getFlag: (flag) => flag === "no-lsp" || flag === "no-ast-grep",
			},
			{ blockingOnly: false },
		);

		expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).toContain(
			"no-important",
		);
		expect(runners.map(({ runnerId }) => runnerId)).toContain("ast-grep-napi");
		const dispatchStart = latencyEntries.find(
			(entry) => entry.phase === "dispatch_start",
		);
		expect(dispatchStart?.metadata?.runners).toContain("ast-grep-napi");
		// A real full-catalog dispatch; vitest's default 5s budget is not enough
		// for it on a loaded worker pool (#2336).
	}, 30_000);
});
