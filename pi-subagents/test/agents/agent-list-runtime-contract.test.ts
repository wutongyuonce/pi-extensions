import {
	afterEach,
	assert,
	createTestDir,
	describe,
	getAgentListEntriesForTest,
	it,
	join,
	mkdirSync,
	renderAgentListReminderForTest,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

function createAgentRoot(): { baseCwd: string; agentsDir: string } {
	const baseCwd = createTestDir();
	const configDir = join(baseCwd, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	return { baseCwd, agentsDir };
}

function withAgentRoot<T>(agentsDir: string, run: () => T): T {
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(agentsDir, "..");
	try {
		return run();
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
}

function writeAgent(agentsDir: string, name: string, frontmatter: string): void {
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${name} behavior\n${frontmatter}\n---\n\nAgent body.`,
	);
}

function blockFor(reminder: string, name: string): string {
	return reminder.match(new RegExp("^- `" + name + "`:[\\s\\S]*?(?=\\n\\n|\\n</subagent-roster>)", "m"))?.[0] ?? "";
}

describe("agent-list runtime contract", () => {
	afterEach(() => resetSubagentStateForTest());

	it("describes explicit async contracts separately from the await-all session override", () => {
		const { baseCwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "sync-worker", "async: false");
		writeAgent(agentsDir, "async-worker", "async: true");
		writeAgent(agentsDir, "default-worker", "");

		withAgentRoot(agentsDir, () => {
			const entries = getAgentListEntriesForTest(baseCwd);
			const reminder = renderAgentListReminderForTest(entries);
			assert.match(blockFor(reminder, "sync-worker"), /tool_return: wait_here/);
			assert.match(blockFor(reminder, "async-worker"), /tool_return: later_message/);
			assert.match(blockFor(reminder, "default-worker"), /tool_return: later_message/);

			const awaitedReminder = renderAgentListReminderForTest(entries, { awaitAllLaunches: true });
			for (const name of ["sync-worker", "async-worker", "default-worker"]) {
				assert.match(blockFor(awaitedReminder, name), /tool_return: wait_here/);
			}
		});
	});

	it("includes model guidance when an agent allows overrides without a default model", () => {
		const { baseCwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "open-model", "allow-model-override: true");

		withAgentRoot(agentsDir, () => {
			const reminder = renderAgentListReminderForTest(getAgentListEntriesForTest(baseCwd));
			assert.match(reminder, /models: any model ref/);
			assert.match(reminder, /`models:` lists accepted overrides/);
		});
	});

	it("includes model guidance for a default model even when overrides are disabled", () => {
		const { baseCwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "pinned-model", "model: provider/model\nallow-model-override: false");

		withAgentRoot(agentsDir, () => {
			const reminder = renderAgentListReminderForTest(getAgentListEntriesForTest(baseCwd));
			assert.match(reminder, /default_model: provider\/model/);
			assert.match(reminder, /`models:` lists accepted overrides/);
			assert.doesNotMatch(blockFor(reminder, "pinned-model"), /\n {2}models:/);
		});
	});

	it("adds verifier handling guidance only when a roster entry is marked for fan-out", () => {
		const marked = createAgentRoot();
		writeAgent(marked.agentsDir, "verified-worker", "llm-as-a-verifier: true");
		withAgentRoot(marked.agentsDir, () => {
			const reminder = renderAgentListReminderForTest(getAgentListEntriesForTest(marked.baseCwd));
			assert.match(reminder, /`llm-as-a-verifier: true` means one launch/);
		});

		const plain = createAgentRoot();
		writeAgent(plain.agentsDir, "plain-worker", "");
		withAgentRoot(plain.agentsDir, () => {
			const reminder = renderAgentListReminderForTest(getAgentListEntriesForTest(plain.baseCwd));
			assert.doesNotMatch(reminder, /`llm-as-a-verifier: true` means one launch/);
		});
	});
});
