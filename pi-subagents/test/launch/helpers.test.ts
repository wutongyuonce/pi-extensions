import {
	assert,
	buildPiPromptArgsForTest,
	createTestDir,
	describe,
	getShellReadyDelayMs,
	it,
	join,
	mkdirSync,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";

describe("launch helpers", () => {
	it("uses a configurable shell-ready delay", () => {
		delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
		assert.equal(getShellReadyDelayMs(), 500);

		process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
		assert.equal(getShellReadyDelayMs(), 2500);

		process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "nope";
		assert.equal(getShellReadyDelayMs(), 500);
	});

	it("inserts a separator before skill prompts for artifact-backed launches", () => {
		assert.deepEqual(buildPiPromptArgsForTest(["debugger", "pua"], "@/tmp/task.md", false), [
			"",
			"/skill:debugger",
			"/skill:pua",
			"@/tmp/task.md",
		]);
		assert.deepEqual(buildPiPromptArgsForTest(["debugger"], "do work", true), ["/skill:debugger", "do work"]);
		assert.deepEqual(buildPiPromptArgsForTest(["research"], "@/tmp/fork-task.md", true), [
			"",
			"/skill:research",
			"@/tmp/fork-task.md",
		]);
		assert.deepEqual(buildPiPromptArgsForTest([], "@/tmp/task.md", true), ["", "@/tmp/task.md"]);
	});

	it("registers set_tab_title only when explicitly enabled", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "worker.md"), "---\nname: worker\ndescription: Worker\n---\n\nWorker body.");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const original = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		const tools = new Map<string, any>();
		delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;

		try {
			subagentsExtension({
				on() {},
				registerCommand() {},
				registerMessageRenderer() {},
				sendMessage() {},
				registerTool(definition: any) {
					tools.set(definition.name, definition);
					return definition;
				},
			} as any);
			assert.equal(tools.has("set_tab_title"), false);

			process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
			tools.clear();
			subagentsExtension({
				on() {},
				registerCommand() {},
				registerMessageRenderer() {},
				sendMessage() {},
				registerTool(definition: any) {
					tools.set(definition.name, definition);
					return definition;
				},
			} as any);
			assert.equal(tools.has("set_tab_title"), true);
		} finally {
			if (original == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = original;
		}
	});
});
