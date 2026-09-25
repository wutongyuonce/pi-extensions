import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	getSubagentBatchStopMetadataForTest,
	resetSubagentStateForTest,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

function writeAsyncChildSession(dir: string): string {
	const sessionFile = join(dir, "async-child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			timestamp: new Date().toISOString(),
			cwd: dir,
		})}\n`,
	);
	writeSubagentLaunchMetadataEntry(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "async-child",
		mode: "background",
		sessionMode: "lineage-only",
		autoExit: true,
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: false,
	} as PersistedSubagentLaunchMetadata);
	return sessionFile;
}

function registerResumeTool() {
	const awaited: RunningSubagent[] = [];
	const empty = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
	const runtime = {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: empty,
		watchSubagent: empty,
		getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map<string, unknown>(),
		wireSubagentSteerBack: () => {},
		getLaunchedSubagentResult: async (running: RunningSubagent) => {
			awaited.push(running);
			return { content: [{ type: "text", text: "completed" }], details: { status: "completed" } };
		},
	};
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerSubagentResumeTool(
		{
			registerTool(definition: { name: string }) {
				tools.set(definition.name, definition as never);
				return definition;
			},
		} as never,
		() => true,
		runtime as never,
	);
	return { tool: tools.get("subagent_resume")!, awaited };
}

function withFakePi<T>(bin: string, run: () => Promise<T>): Promise<T> {
	const original = process.env.PI_SUBAGENT_PI_COMMAND;
	process.env.PI_SUBAGENT_PI_COMMAND = bin;
	return run().finally(() => {
		if (original == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = original;
	});
}

describe("subagent_resume from a headless parent", () => {
	afterEach(() => resetSubagentStateForTest());

	it("awaits an async resume and does not end the turn when the parent has no UI", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeAsyncChildSession(dir);
			const { tool, awaited } = registerResumeTool();

			const result = (await tool.execute("call-1", { sessionFile }, undefined, undefined, { hasUI: false })) as {
				details: { status?: string };
				terminate?: true;
			};

			assert.equal(awaited.length, 1, "a headless parent must wait for the resumed child");
			assert.equal(awaited[0].blocking, true);
			assert.equal(awaited[0].async, false);
			assert.deepEqual(getSubagentBatchStopMetadataForTest(), {});
			assert.equal(result.details.status, "completed");
			assert.equal(result.terminate, undefined);
		});
	});

	it("keeps an async resume detached when the parent has a UI", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeAsyncChildSession(dir);
			const { tool, awaited } = registerResumeTool();

			const result = (await tool.execute("call-1", { sessionFile }, undefined, undefined, { hasUI: true })) as {
				details: { status?: string };
				terminate?: true;
			};

			assert.equal(awaited.length, 0);
			assert.equal(result.details.status, "started");
			assert.equal(result.terminate, true);
		});
	});
});
