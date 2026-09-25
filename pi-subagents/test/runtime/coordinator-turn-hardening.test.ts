import { rmSync } from "node:fs";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { getLiveSlotCount } from "../../src/runtime/spawn-width.ts";
import { markInitialPromptLaunchComplete, registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import {
	assert,
	afterEach,
	createTestDir,
	describe,
	getLaunchedSubagentResultForTest,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
	subagentsExtension,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { gitRun, setupVerifiedRunFixture } from "../support/verified-runs.ts";

type LaunchRecord = {
	kind: "background" | "interactive";
	params: SubagentParamsInput;
	context: { autoExit?: boolean; parentModelRef?: string; parentThinking?: string };
};

function makeRunning(params: SubagentParamsInput, mode: "background" | "interactive"): RunningSubagent {
	return {
		id: `${mode}-child`,
		name: params.name,
		task: params.task,
		title: params.title,
		agent: params.agent,
		mode,
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		blocking: params.blocking,
		async: params.async,
		startTime: Date.now(),
		sessionFile: `/tmp/${mode}-child.jsonl`,
	};
}

function makeLaunchRuntime(
	defs: AgentDefaults,
	records: LaunchRecord[],
	watchKinds: Array<"background" | "interactive"> = [],
): SubagentToolRuntime {
	const launch = async (
		params: SubagentParamsInput,
		context: { autoExit?: boolean; parentModelRef?: string; parentThinking?: string },
		kind: "background" | "interactive",
	): Promise<RunningSubagent> => {
		records.push({ kind, params: { ...params }, context });
		const running = makeRunning(params, kind);
		setRunningSubagentForTest(running);
		return running;
	};
	const watch = async (running: RunningSubagent, kind: "background" | "interactive"): Promise<SubagentResult> => {
		watchKinds.push(kind);
		return {
			name: running.name,
			task: running.task,
			summary: `${kind} result`,
			summarySource: "subagent",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 1,
		};
	};

	return {
		loadAgentDefaults: () => defs,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: (params, context) => launch(params, context, "background"),
		launchSubagent: (params, context) => launch(params, context, "interactive"),
		watchBackgroundSubagent: (running) => watch(running, "background"),
		watchSubagent: (running) => watch(running, "interactive"),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux unavailable" }], details: {} }),
	};
}

async function withFakeTmux<T>(available: boolean, run: () => Promise<T>): Promise<T> {
	const dir = createTestDir();
	if (available) writeExecutable(dir, "tmux", "#!/bin/sh\nexit 0\n");
	const savedPath = process.env.PATH;
	const savedMux = process.env.PI_SUBAGENT_MUX;
	const savedTmux = process.env.TMUX;
	process.env.PATH = available ? `${dir}:${savedPath ?? ""}` : dir;
	process.env.PI_SUBAGENT_MUX = "tmux";
	process.env.TMUX = "fake-tmux";
	try {
		return await run();
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		if (savedMux === undefined) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = savedMux;
		if (savedTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = savedTmux;
	}
}

function registerCoreTool(runtime: SubagentToolRuntime) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerSubagentCoreTools(
		{
			registerTool(definition: { name: string }) {
				tools.set(definition.name, definition as never);
				return definition;
			},
			getThinkingLevel: () => "high",
		} as never,
		() => true,
		runtime,
	);
	const tool = tools.get("subagent");
	if (!tool) throw new Error("subagent tool was not registered");
	return tool;
}

describe("coordinator-turn launch hardening", () => {
	afterEach(() => resetSubagentStateForTest());

	it("selects interactive and fallback background launch paths and preserves launch context", async () => {
		// The startup prompt has ended, so a UI session with an interactive agent
		// must retain the pane path instead of being forced into a background run.
			markInitialPromptLaunchComplete();
			const defs: AgentDefaults = { spawning: false, mode: "interactive", async: true };
			const records: LaunchRecord[] = [];
			const watchKinds: Array<"background" | "interactive"> = [];
			const runtime = makeLaunchRuntime(defs, records, watchKinds);
		const tool = registerCoreTool(runtime);
		const context = {
			hasUI: true,
			cwd: process.cwd(),
			model: { provider: "provider", id: "model" },
			sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" },
		};

		await withFakeTmux(true, async () => {
			const result = (await tool.execute(
				"interactive-call",
				{ agent: "ui-child", name: "ui-child", title: "UI child", task: "Use the pane" },
				undefined,
				undefined,
				context,
			)) as { details: { status?: string } };
			assert.equal(result.details.status, "started");
		});

		assert.equal(records[0]?.kind, "interactive");
		assert.deepEqual(watchKinds, ["interactive"], "interactive launches must use the interactive watcher");
		assert.equal(records[0]?.context.parentModelRef, "provider/model");
		assert.equal(records[0]?.context.parentThinking, "high");
		assert.equal(records[0]?.context.autoExit, undefined);

		resetSubagentStateForTest();
		const unavailableRecords: LaunchRecord[] = [];
		const unavailableWatchKinds: Array<"background" | "interactive"> = [];
		const unavailableTool = registerCoreTool(makeLaunchRuntime(defs, unavailableRecords, unavailableWatchKinds));
		await withFakeTmux(false, async () => {
			const result = (await unavailableTool.execute(
				"fallback-call",
				{ agent: "ui-child", name: "ui-child", title: "Fallback child", task: "Use the background fallback" },
				undefined,
				undefined,
				context,
			)) as { details: { status?: string } };
			assert.equal(result.details.status, "started");
		});
		assert.equal(unavailableRecords[0]?.kind, "background");
		assert.deepEqual(unavailableWatchKinds, ["background"], "mux fallback launches must use the background watcher");

		resetSubagentStateForTest();
		const headlessRecords: LaunchRecord[] = [];
		const headlessWatchKinds: Array<"background" | "interactive"> = [];
		const headlessTool = registerCoreTool(makeLaunchRuntime({ ...defs, autoExit: true }, headlessRecords, headlessWatchKinds));
		const result = (await headlessTool.execute(
			"headless-call",
			{ agent: "ui-child", name: "ui-child", title: "Headless child", task: "Return the report" },
			undefined,
			undefined,
			{ ...context, hasUI: false },
		)) as { details: { status?: string }; terminate?: true };

		assert.equal(headlessRecords[0]?.kind, "background");
		assert.deepEqual(
			{ async: headlessRecords[0]?.params.async, blocking: headlessRecords[0]?.params.blocking },
			{ async: false, blocking: true },
		);
		assert.deepEqual(headlessWatchKinds, ["background"], "headless launches must use the background watcher");
		assert.equal(headlessRecords[0]?.context.autoExit, undefined, "explicit auto-exit must not receive a second override");
		assert.equal(result.details.status, "completed");
		assert.equal(result.terminate, undefined);

		resetSubagentStateForTest();
		const forcedAutoExitRecords: LaunchRecord[] = [];
		const forcedAutoExitTool = registerCoreTool(makeLaunchRuntime({ ...defs, autoExit: false }, forcedAutoExitRecords));
		await forcedAutoExitTool.execute(
			"headless-manual-call",
			{ agent: "ui-child", name: "ui-child", title: "Headless manual child", task: "Return the report" },
			undefined,
			undefined,
			{ ...context, hasUI: false },
		);
		assert.equal(
			forcedAutoExitRecords[0]?.context.autoExit,
			true,
			"a forced synchronous launch must give a non-auto-exit agent a bounded auto-exit override",
		);
	});

	it("routes a verified definition through its preflight seam instead of launching an ordinary child", async () => {
		const records: LaunchRecord[] = [];
		const runtime = makeLaunchRuntime(
			{
				spawning: false,
				mode: "background",
				llmAsVerifier: true,
				llmAsVerifierCriteria: "missing-criteria",
			},
			records,
		);
		const tool = registerCoreTool(runtime);

		await assert.rejects(
			() =>
				tool.execute(
					"verified-call",
					{ agent: "verified-child", name: "verified-child", title: "Verified child", task: "Verify this" },
					undefined,
					undefined,
					{ hasUI: false, cwd: process.cwd(), sessionManager: { getSessionId: () => "parent" } },
				),
			/llm-as-a-verifier-criteria.*matches no criteria file/,
		);
		assert.deepEqual(records, [], "verified launches must not fall through to an ordinary child path");
	});

	it("returns a successful verified launch through the awaited public tool result", async () => {
		const { repo, parent, fakePi, captureDir } = setupVerifiedRunFixture();
		const artifactRoot = createTestDir();
		const agentDir = join(repo, ".pi", "agents");
		mkdirSync(join(agentDir, "verifiers"), { recursive: true });
		writeFileSync(
			join(agentDir, "verified-child.md"),
			"---\nname: verified-child\ndescription: Verified worker\nmode: background\n---\n\nWorker body.\n",
		);
		writeFileSync(
			join(agentDir, "verifiers", "default.md"),
			"---\nmodel: deepseek/deepseek-v4-flash\nenv: |\n  DEEPSEEK_API_KEY=test-verifier-key\n---\n",
		);
		gitRun(repo, "add", "-A");
		gitRun(repo, "commit", "-q", "-m", "verified agent");

		const saved = {
			piCommand: process.env.PI_SUBAGENT_PI_COMMAND,
			mockVerifier: process.env.PI_SUBAGENT_VF_MOCK_VERIFIER,
			markerMap: process.env.TEST_MARKER_MAP,
			captureDir: process.env.TEST_CAPTURE_DIR,
			artifactRoot: process.env.PI_ARTIFACT_PROJECT_ROOT,
		};
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
		process.env.PI_SUBAGENT_VF_MOCK_VERIFIER = JSON.stringify({ goodMarker: "VF-GOOD", midMarker: "VF-MID" });
		process.env.TEST_MARKER_MAP = JSON.stringify({ "1": "VF-GOOD", "2": "VF-MID" });
		// The fake candidates write argv captures into TEST_CAPTURE_DIR. It is
		// not a tracked key, so another suite can leak a stale value pointing
		// at a deleted directory; point it at this test's own fixture.
		process.env.TEST_CAPTURE_DIR = captureDir;
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		try {
			const records: LaunchRecord[] = [];
			const tool = registerCoreTool(
				makeLaunchRuntime(
					{
						spawning: false,
						mode: "background",
						llmAsVerifier: true,
						llmAsVerifierCandidates: 2,
					},
					records,
				),
			);
			const result = (await tool.execute(
				"verified-call",
				{ agent: "verified-child", name: "verified-child", title: "Verified child", task: "Verify this" },
				undefined,
				undefined,
				{
					hasUI: false,
					cwd: repo,
					sessionManager: {
						getSessionFile: () => join(parent, "parent-session.jsonl"),
						getSessionId: () => "parent-session",
					},
				},
			)) as { content: Array<{ type: string; text: string }>; details: { status?: string }; terminate?: true };

			assert.deepEqual(records, [], "the verified branch owns the launch rather than calling ordinary runtime launchers");
			assert.equal(result.details.status, "completed");
				assert.equal(result.terminate, undefined);
				assert.match(result.content[0]?.text ?? "", /Final report for VF-(GOOD|MID)/);
				assert.equal(getLiveSlotCount(), 0, "verified completion must release the pre-reserved candidate slots exactly once");
			} finally {
			if (saved.piCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = saved.piCommand;
			if (saved.mockVerifier === undefined) delete process.env.PI_SUBAGENT_VF_MOCK_VERIFIER;
			else process.env.PI_SUBAGENT_VF_MOCK_VERIFIER = saved.mockVerifier;
			if (saved.markerMap === undefined) delete process.env.TEST_MARKER_MAP;
			else process.env.TEST_MARKER_MAP = saved.markerMap;
			if (saved.captureDir === undefined) delete process.env.TEST_CAPTURE_DIR;
			else process.env.TEST_CAPTURE_DIR = saved.captureDir;
			if (saved.artifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
			else process.env.PI_ARTIFACT_PROJECT_ROOT = saved.artifactRoot;
			rmSync(artifactRoot, { recursive: true, force: true });
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("wires await-all roster guidance only for a headless session", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(configDir, "agents", "worker.md"),
			"---\nname: worker\ndescription: A roster worker\nmode: background\n---\n\nWorker body.",
		);

		const originalArgv = process.argv;
		process.argv = ["node", "pi"];
		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			subagentsExtension({
				on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
					handlers.set(event, handler);
				},
				registerTool() {},
				registerCommand() {},
				registerMessageRenderer() {},
				sendMessage() {},
			} as never);
			const ctx = {
				cwd: dir,
				hasUI: true,
				ui: { setWidget() {} },
				sessionManager: {
					getHeader: () => ({ id: "parent", type: "session", timestamp: "", cwd: dir }),
				},
			};
			handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			const message = (handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx) as {
				message?: { content: string };
			} | undefined)?.message;
			assert.ok(message);
			assert.match(message.content, /tool_return: later_message/);
			assert.match(message.content, /tool_return=later_message/);
			assert.doesNotMatch(message.content, /In this session every launch waits/);
		} finally {
			process.argv = originalArgv;
		}
	});
});
