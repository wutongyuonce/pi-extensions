import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";

interface CapturedRegistrations {
	handlers: Map<string, unknown>;
	tools: string[];
	commands: string[];
	shortcuts: string[];
	renderers: string[];
}

function createCapturingPi(): { captured: CapturedRegistrations; api: ExtensionAPI } {
	const captured: CapturedRegistrations = {
		handlers: new Map(),
		tools: [],
		commands: [],
		shortcuts: [],
		renderers: [],
	};
	const api = {
		on(event: string, handler: unknown) {
			captured.handlers.set(event, handler);
		},
		registerTool(tool: { name: string }) {
			captured.tools.push(tool.name);
		},
		registerCommand(name: string) {
			captured.commands.push(name);
		},
		registerShortcut(shortcut: string) {
			captured.shortcuts.push(shortcut);
		},
		registerMessageRenderer(customType: string) {
			captured.renderers.push(customType);
		},
	} as unknown as ExtensionAPI;
	return { captured, api };
}

function writeGlobalAgent(configDir: string, frontmatter: string): void {
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "worker.md"), `---\n${frontmatter}\n---\n\nWorker body.`);
}

describe("extension registration gating", () => {
	afterEach(() => resetSubagentStateForTest());

	it("registers no tools, commands, shortcuts, renderers, or handlers when no agent definitions exist", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assert.deepEqual(captured.tools, []);
			assert.deepEqual(captured.commands, []);
			assert.deepEqual(captured.shortcuts, []);
			assert.deepEqual(captured.renderers, []);
			assert.deepEqual([...captured.handlers.keys()], []);
		} finally {
			process.chdir(prevCwd);
		}
	});

	it("registers the full subagent surface when an agent definition exists", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		writeGlobalAgent(configDir, "name: worker\ndescription: Worker for gating tests");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const setTabTitleOptIn = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assert.deepEqual([...captured.tools].sort(), ["subagent", "subagent_kill", "subagent_resume"]);
			assert.deepEqual(captured.commands, ["subagents"]);
			assert.deepEqual(captured.shortcuts, ["alt+s"]);
			assert.deepEqual([...captured.renderers].sort(), ["subagent_ping", "subagent_result"]);
			assert.deepEqual(
				[...captured.handlers.keys()].sort(),
				[
					"agent_end",
					"before_agent_start",
					"input",
					"message_end",
					"session_shutdown",
					"session_start",
					"session_tree",
					"tool_call",
					"turn_start",
				],
			);
		} finally {
			process.chdir(prevCwd);
			if (setTabTitleOptIn == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = setTabTitleOptIn;
		}
	});

	it("registers nothing when the only agent definition is disabled", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		writeGlobalAgent(configDir, "name: worker\ndescription: Disabled worker\nenabled: false");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assert.deepEqual(captured.tools, []);
			assert.deepEqual(captured.commands, []);
			assert.deepEqual(captured.shortcuts, []);
			assert.deepEqual(captured.renderers, []);
			assert.deepEqual([...captured.handlers.keys()], []);
		} finally {
			process.chdir(prevCwd);
		}
	});
});
