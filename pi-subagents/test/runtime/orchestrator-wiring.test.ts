import { mkdirSync, writeFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildOrchestratorSessionState } from "../../src/session/orchestrator-state.ts";
import {
	afterEach,
	assert,
	clearIsolatedSubagentEnv,
	createTestDir,
	describe,
	it,
	join,
	subagentsExtension,
} from "../support/index.ts";

type CapturedHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface CapturedExtension {
	handlers: Map<string, CapturedHandler>;
	activeTools: () => string[];
	session: SessionManager;
	context: ExtensionContext;
}

function createExtensionHarness(
	orchestratorMode: string,
	child = false,
): CapturedExtension {
	clearIsolatedSubagentEnv();
	const root = createTestDir();
	const agentDir = join(root, "agent-root");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", "worker.md"),
		"---\nname: worker\ndescription: Wiring test worker\n---\n\nWorker body.",
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_ORCHESTRATOR_MODE = orchestratorMode;
	process.env.PI_SUBAGENT_AGENT = child ? "worker" : "";
	process.env.PI_SUBAGENT_NAME = child ? "worker" : "";

	const session = SessionManager.inMemory(root);
	let tools = ["read", "bash", "subagent", "subagent_kill", "subagent_resume"];
	const handlers = new Map<string, CapturedHandler>();
	const api = {
		on(event: string, handler: CapturedHandler) {
			handlers.set(event, handler);
		},
		appendEntry(customType: string, data: unknown) {
			session.appendCustomEntry(customType, data);
		},
		getActiveTools() {
			return [...tools];
		},
		setActiveTools(next: string[]) {
			tools = [...next];
		},
		getAllTools() {
			return tools.map((name) => ({ name }));
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
	};

	const context = {
		cwd: root,
		mode: "print" as const,
		hasUI: false,
		ui: {
			notify() {},
			setWidget() {},
		},
		sessionManager: session,
		modelRegistry: { getAvailable: () => [] },
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "base",
		// SAFETY: This fixture exercises orchestrator event wiring only; the other
		// ExtensionUIContext methods are intentionally unused by these handlers.
	} as unknown as ExtensionContext;

	subagentsExtension(api as unknown as ExtensionAPI);
	return { handlers, activeTools: () => [...tools], session, context };
}

describe("orchestrator extension wiring", () => {
	afterEach(() => clearIsolatedSubagentEnv());

	it("enforces the resolved mode at lifecycle, prompt, and tool boundaries", () => {
		const harness = createExtensionHarness("1");
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			harness.context,
		);
		assert.deepEqual(harness.activeTools(), [
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const start = harness.handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "delegate",
				systemPrompt: "base",
				systemPromptOptions: {
					cwd: harness.context.cwd,
					appendSystemPrompt: "preserve this",
				},
			},
			harness.context,
		) as { systemPrompt?: string } | undefined;
		assert.match(start?.systemPrompt ?? "", /preserve this$/);

		const blocked = harness.handlers.get("tool_call")?.(
			{ toolName: "bash" },
			harness.context,
		) as
			| {
					block?: boolean;
			  }
			| undefined;
		assert.equal(blocked?.block, true);
	});

	it("lets branch state override inherited env mode during reload", () => {
		const harness = createExtensionHarness("1");
		harness.session.appendCustomEntry(
			"pi-subagents:orchestrator",
			buildOrchestratorSessionState(false, [
				"read",
				"bash",
				"subagent",
				"subagent_kill",
				"subagent_resume",
			]),
		);
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "reload" },
			harness.context,
		);
		assert.deepEqual(harness.activeTools(), [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const result = harness.handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: "base",
				systemPromptOptions: { cwd: harness.context.cwd },
			},
			harness.context,
		) as { systemPrompt?: string } | undefined;
		assert.equal(result?.systemPrompt, undefined);
	});

	it("does not inherit orchestration mode in a child process", () => {
		const harness = createExtensionHarness("1", true);
		harness.session.appendCustomEntry(
			"pi-subagents:orchestrator",
			buildOrchestratorSessionState(true, ["read", "bash", "subagent"]),
		);
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			harness.context,
		);
		assert.deepEqual(harness.activeTools(), [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const result = harness.handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "work",
				systemPrompt: "base",
				systemPromptOptions: { cwd: harness.context.cwd },
			},
			harness.context,
		) as { systemPrompt?: string } | undefined;
		assert.equal(result?.systemPrompt, undefined);
	});
});
