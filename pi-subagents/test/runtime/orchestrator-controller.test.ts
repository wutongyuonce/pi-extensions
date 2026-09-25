import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	loadOrchestratorGlobalConfig,
	saveOrchestratorGlobalDefault,
} from "../../src/runtime/orchestrator-config.ts";
import {
	createOrchestratorController,
	type OrchestratorContext,
	type OrchestratorRuntimeAPI,
} from "../../src/runtime/orchestrator-controller.ts";
import {
	appendOrchestratorSessionState,
	buildOrchestratorSessionState,
	readOrchestratorSessionState,
} from "../../src/session/orchestrator-state.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
} from "../support/index.ts";

function createRuntime(
	activeTools: string[],
	session = SessionManager.inMemory(createTestDir()),
) {
	let currentTools = [...activeTools];
	const pi: OrchestratorRuntimeAPI = {
		appendEntry(customType: string, data: unknown) {
			assert.equal(customType, "pi-subagents:orchestrator");
			session.appendCustomEntry(customType, data);
		},
		getActiveTools() {
			return [...currentTools];
		},
		setActiveTools(toolNames: string[]) {
			currentTools = [...toolNames];
		},
	};
	const ctx: OrchestratorContext = {
		hasPendingMessages: () => false,
		isIdle: () => true,
		sessionManager: session,
		ui: { notify() {} },
	};
	return { pi, session, ctx, getActiveTools: () => [...currentTools] };
}

describe("orchestrator runtime persistence", () => {
	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("stores the global default beside the agent config and preserves unrelated properties", () => {
		const agentDir = createTestDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const configPath = join(agentDir, "pi-subagents.json");
		writeFileSync(
			configPath,
			JSON.stringify({ theme: "dark", nested: { keep: true } }),
		);

		const result = saveOrchestratorGlobalDefault(true);

		assert.equal(result.ok, true);
		assert.equal(existsSync(configPath), true);
		assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
			theme: "dark",
			nested: { keep: true },
			orchestratorDefault: true,
		});
		assert.deepEqual(loadOrchestratorGlobalConfig(), {
			path: configPath,
			savedDefault: true,
			source: "saved",
		});
	});

	it("persists and restores the selected mode from the current session branch", () => {
		const session = SessionManager.inMemory(createTestDir());

		appendOrchestratorSessionState(session, true, ["read", "subagent"]);

		assert.deepEqual(readOrchestratorSessionState(session.getBranch()), {
			enabled: true,
			activeTools: ["read", "subagent"],
		});
		assert.equal(session.getBranch().at(-1)?.type, "custom");
		assert.equal(
			(session.getBranch().at(-1) as { customType?: string }).customType,
			"pi-subagents:orchestrator",
		);
	});

	it("resolves startup mode from the environment, narrows tools, and restores the active baseline", () => {
		const runtime = createRuntime([
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);

		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, true);
		assert.deepEqual(runtime.getActiveTools(), [
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);
		assert.deepEqual(controller.getSnapshot(runtime.ctx).normalActiveTools, [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const result = controller.setMode(false, runtime.ctx);
		assert.equal(result.ok, true);
		assert.deepEqual(runtime.getActiveTools(), [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);
	});

	it("restores the persisted active baseline after a restart adds default tools", () => {
		const session = SessionManager.inMemory(createTestDir());
		const initial = createRuntime(["read", "subagent"], session);
		const initialController = createOrchestratorController(initial.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		initialController.handleSessionStart(initial.ctx);
		assert.equal(initialController.setMode(true, initial.ctx).ok, true);

		const restarted = createRuntime(
			["read", "bash", "edit", "write", "subagent"],
			session,
		);
		const restartedController = createOrchestratorController(restarted.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		restartedController.handleSessionStart(restarted.ctx);

		assert.equal(
			restartedController.getSnapshot(restarted.ctx).currentMode,
			true,
		);
		assert.deepEqual(
			restartedController.getSnapshot(restarted.ctx).normalActiveTools,
			["read", "subagent"],
		);
		assert.equal(restartedController.setMode(false, restarted.ctx).ok, true);
		assert.deepEqual(restarted.getActiveTools(), ["read", "subagent"]);
	});

	it("persists off/on/off transitions from the live normal tool snapshot", () => {
		const runtime = createRuntime(["read", "bash", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		controller.handleSessionStart(runtime.ctx);

		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, false);
		assert.equal(controller.setMode(true, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), ["subagent"]);
		assert.equal(controller.setMode(false, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), ["read", "bash", "subagent"]);
	});

	it("applies env, saved, and branch precedence in that order", () => {
		const agentDir = createTestDir();
		assert.equal(saveOrchestratorGlobalDefault(true, agentDir).ok, true);

		const envOff = createRuntime(["read", "subagent"]);
		const envController = createOrchestratorController(envOff.pi, {
			agentDir,
			environment: { PI_ORCHESTRATOR_MODE: "0" },
		});
		envController.handleSessionStart(envOff.ctx);
		assert.equal(envController.getSnapshot(envOff.ctx).currentMode, false);

		const savedOn = createRuntime(["read", "subagent"]);
		const savedController = createOrchestratorController(savedOn.pi, {
			agentDir,
			environment: {},
		});
		savedController.handleSessionStart(savedOn.ctx);
		assert.equal(savedController.getSnapshot(savedOn.ctx).currentMode, true);

		const branchOn = createRuntime(["read", "subagent"]);
		appendOrchestratorSessionState(branchOn.session, true, [
			"read",
			"subagent",
		]);
		const branchController = createOrchestratorController(branchOn.pi, {
			agentDir,
			environment: { PI_ORCHESTRATOR_MODE: "0" },
		});
		branchController.handleSessionStart(branchOn.ctx);
		assert.equal(branchController.getSnapshot(branchOn.ctx).currentMode, true);
	});

	it("does not restore a stale baseline when another extension already disabled a tool", () => {
		const runtime = createRuntime(["read"]);
		appendOrchestratorSessionState(runtime.session, false, ["read", "bash"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		controller.handleSessionStart(runtime.ctx);

		assert.deepEqual(controller.getSnapshot(runtime.ctx).normalActiveTools, [
			"read",
		]);
		assert.equal(controller.setMode(true, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), []);
		assert.equal(controller.setMode(false, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), ["read"]);
	});

	it("restores branch state across tree navigation and session reload", () => {
		const runtime = createRuntime(["read", "bash", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);
		const enabledEntry = runtime.session.getLeafId();
		assert.ok(enabledEntry);

		runtime.session.appendCustomEntry(
			"pi-subagents:orchestrator",
			buildOrchestratorSessionState(false, ["read"]),
		);
		runtime.session.branch(enabledEntry);
		controller.handleSessionTree(runtime.ctx);
		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, true);
		assert.deepEqual(runtime.getActiveTools(), ["subagent"]);

		controller.handleSessionStart(runtime.ctx);
		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, true);
		assert.deepEqual(runtime.getActiveTools(), ["subagent"]);
	});

	it("blocks mode changes for busy parents and all orchestration changes in children", () => {
		const runtime = createRuntime(["read", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: {},
			getRunningSubagentCount: () => 1,
		});
		controller.handleSessionStart(runtime.ctx);
		assert.equal(
			controller.setMode(true, runtime.ctx).reason,
			"running-subagents",
		);

		const child = createRuntime(["read", "subagent"]);
		const childController = createOrchestratorController(child.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1", PI_SUBAGENT_AGENT: "worker" },
		});
		childController.handleSessionStart(child.ctx);
		assert.equal(childController.getSnapshot(child.ctx).currentMode, false);
		assert.deepEqual(child.getActiveTools(), ["read", "subagent"]);
		assert.equal(
			childController.setMode(true, child.ctx).reason,
			"child-session",
		);
		assert.equal(
			childController.saveGlobalDefault(true, child.ctx).reason,
			"child-session",
		);
	});

	it("blocks disallowed calls and preserves appended system prompt text", () => {
		const runtime = createRuntime(["read", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);

		const result = controller.beforeAgentStart({
			systemPromptOptions: { cwd: "/tmp", appendSystemPrompt: "keep this" },
		});
		assert.ok(result);
		assert.match(result.systemPrompt, /keep this$/);
		assert.equal(controller.handleToolCall({ toolName: "bash" })?.block, true);
		assert.equal(
			controller.handleToolCall({ toolName: "subagent" }),
			undefined,
		);
	});

	it("falls back safely for malformed config and write failures", () => {
		const agentDir = createTestDir();
		writeFileSync(join(agentDir, "pi-subagents.json"), "not json");
		const notices: string[] = [];
		const runtime = createRuntime(["read"]);
		runtime.ctx.ui.notify = (message) => notices.push(message);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir,
			environment: {},
		});
		controller.handleSessionStart(runtime.ctx);
		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, false);
		assert.ok(controller.getSnapshot(runtime.ctx).globalConfigError);
		assert.equal(notices.length, 1);

		const fileAgentDir = join(createTestDir(), "not-a-directory");
		writeFileSync(fileAgentDir, "file");
		const writeController = createOrchestratorController(runtime.pi, {
			agentDir: fileAgentDir,
		});
		assert.equal(writeController.saveGlobalDefault(true).ok, false);
	});

	it("does not accept mode aliases from the new session metadata format", () => {
		const session = SessionManager.inMemory(createTestDir());
		session.appendCustomEntry("pi-subagents:orchestrator", {
			version: 1,
			mode: "on",
		});
		assert.equal(readOrchestratorSessionState(session.getBranch()), undefined);
	});
});
