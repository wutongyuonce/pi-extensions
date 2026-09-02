import test from "node:test";
import assert from "node:assert/strict";
import {
	isPiCommand,
	runPiCommand,
	resolveSelect,
	tryConsumeSelect,
	clearPendingSelect,
	THINKING_LEVELS,
} from "../../../src/commands/pi-command-adapter.ts";
import type { PiSessionHandle } from "../../../src/sessions/conversation-manager.js";
import type { PiCommandDeps } from "../../../src/commands/pi-command-adapter.js";

function fakeHandle(overrides: Partial<PiSessionHandle> = {}): PiSessionHandle {
	return {
		sessionId: "s1",
		sessionFile: "/tmp/s.jsonl",
		async prompt() {},
		subscribe() {
			return () => undefined;
		},
		getLastAssistantText() {
			return "hello";
		},
		getModelLabel() {
			return "m1";
		},
		async dispose() {},
		async setModel() {
			return true;
		},
		async cycleModel() {
			return "m2";
		},
		async setThinkingLevel() {},
		getThinkingLevel() {
			return "medium";
		},
		getAvailableThinkingLevels() {
			return ["off", "medium", "high"];
		},
		async compact() {
			return "压缩完成";
		},
		async setSessionName() {},
		getSessionSummary() {
			return { modelId: "m1", messageCount: 3, name: "会话A" };
		},
		async executeBash() {
			return "ok";
		},
		...overrides,
	};
}

function makeDeps(overrides: Partial<PiCommandDeps> = {}): PiCommandDeps {
	return {
		async getHandle() {
			return fakeHandle();
		},
		async listModels() {
			return [
				{
					provider: "anthropic",
					id: "claude-sonnet",
					contextWindow: 200,
					reasoning: true,
				},
				{
					provider: "openai",
					id: "gpt-4o",
					contextWindow: 128,
					reasoning: false,
				},
			];
		},
		async listSessions() {
			return [
				{
					path: "/s/a.jsonl",
					name: "任务A",
					messageCount: 5,
					modified: new Date(),
				},
				{
					path: "/s/b.jsonl",
					name: "任务B",
					messageCount: 2,
					modified: new Date(),
				},
			];
		},
		async newConversation() {},
		async switchSession() {},
		async setProviderApiKey() {
			return true;
		},
		...overrides,
	};
}

test("isPiCommand: 内置命令识别", () => {
	assert.equal(isPiCommand("model"), true);
	assert.equal(isPiCommand("compact"), true);
	assert.equal(isPiCommand("goal"), false); // 插件命令 → forward
});

test("runPiCommand /model 无参 → 列出模型 + 进入选择态", async () => {
	clearPendingSelect("k1");
	const res = await runPiCommand(makeDeps(), {
		key: "k1",
		command: "model",
		args: [],
		rawText: "/model",
	});
	assert.equal(res.kind, "handled");
	if (res.kind === "handled") {
		assert.match(res.text, /claude-sonnet/);
		assert.match(res.text, /回复编号/);
	}
	// 用户回复编号 → 解析为模型 id
	const consumed = tryConsumeSelect("k1", "2");
	assert.equal(consumed.consumed, true);
	assert.equal(consumed.text, "__MODEL_SELECT__:gpt-4o");
});

test("runPiCommand /model <id> → 直接切换", async () => {
	let setCalled = "";
	const deps = makeDeps({
		getHandle: async () =>
			fakeHandle({
				async setModel(id) {
					setCalled = id;
					return true;
				},
			}),
	});
	const res = await runPiCommand(deps, {
		key: "k1",
		command: "model",
		args: ["claude-sonnet"],
		rawText: "/model claude-sonnet",
	});
	assert.equal(res.kind, "handled");
	assert.equal(setCalled, "claude-sonnet");
});

test("runPiCommand /thinking <level> → setThinkingLevel；无参 → 列等级", async () => {
	let level = "";
	const deps = makeDeps({
		getHandle: async () =>
			fakeHandle({
				async setThinkingLevel(l) {
					level = l;
				},
			}),
	});
	const res1 = await runPiCommand(deps, {
		key: "k1",
		command: "thinking",
		args: ["high"],
		rawText: "/thinking high",
	});
	assert.equal(level, "high");
	assert.match((res1 as { text: string }).text, /high/);
	const res2 = await runPiCommand(deps, {
		key: "k1",
		command: "thinking",
		args: [],
		rawText: "/thinking",
	});
	assert.match((res2 as { text: string }).text, /可用/);
});

test("runPiCommand /compact → 调用 compact 回显结果", async () => {
	let compacted = "";
	const deps = makeDeps({
		getHandle: async () =>
			fakeHandle({
				async compact(instructions) {
					compacted = instructions ?? "";
					return "压缩摘要：xx";
				},
			}),
	});
	const res = await runPiCommand(deps, {
		key: "k1",
		command: "compact",
		args: ["保留", "重点"],
		rawText: "/compact 保留 重点",
	});
	assert.equal(compacted, "保留 重点");
	assert.match((res as { text: string }).text, /压缩/);
});

test("runPiCommand /resume 无参 → 列会话进入选择态；编号 → 会话路径", async () => {
	clearPendingSelect("k1");
	let switched = "";
	const deps = makeDeps({
		switchSession: async (_k, path) => {
			switched = path;
		},
	});
	const res = await runPiCommand(deps, {
		key: "k1",
		command: "resume",
		args: [],
		rawText: "/resume",
	});
	assert.match((res as { text: string }).text, /任务A/);
	const consumed = tryConsumeSelect("k1", "1");
	assert.equal(consumed.text, "__SESSION_SELECT__:/s/a.jsonl");
	// 选择后 index.ts 会调 switchSession
	await deps.switchSession("k1", consumed.text!.split(":")[1]!);
	assert.equal(switched, "/s/a.jsonl");
});

test("runPiCommand /new → 新会话", async () => {
	let created = false;
	const deps = makeDeps({
		newConversation: async () => {
			created = true;
		},
	});
	const res = await runPiCommand(deps, {
		key: "k1",
		command: "new",
		args: [],
		rawText: "/new",
	});
	assert.equal(created, true);
	assert.equal(res.kind, "handled");
});

test("runPiCommand 非内置（插件/skill）→ forward", async () => {
	const res = await runPiCommand(makeDeps(), {
		key: "k1",
		command: "goal",
		args: ["写个demo"],
		rawText: "/goal 写个demo",
	});
	assert.deepEqual(res, { kind: "forward" });
});

test("runPiCommand /login <provider> <key> → 直接写入 api key", async () => {
	let saved = "";
	const deps = makeDeps({
		setProviderApiKey: async (p, k) => {
			saved = `${p}=${k}`;
			return true;
		},
	});
	const res = await runPiCommand(deps, {
		key: "k1",
		command: "login",
		args: ["my-provider", "sk-1234"],
		rawText: "/login my-provider sk-1234",
	});
	assert.equal(saved, "my-provider=sk-1234");
	assert.match((res as { text: string }).text, /已保存/);
});

test("runPiCommand /login <provider> → 交互输入；下一条消息即 key", async () => {
	clearPendingSelect("k1");
	const res = await runPiCommand(makeDeps(), {
		key: "k1",
		command: "login",
		args: ["my-provider"],
		rawText: "/login my-provider",
	});
	assert.match((res as { text: string }).text, /API key/);
	const consumed = tryConsumeSelect("k1", "sk-abc-xyz");
	assert.equal(consumed.consumed, true);
	assert.equal(consumed.text, "__API_KEY__:my-provider:sk-abc-xyz");
});

test("runPiCommand /login 无参 → 用法提示", async () => {
	const res = await runPiCommand(makeDeps(), {
		key: "k1",
		command: "login",
		args: [],
		rawText: "/login",
	});
	assert.match((res as { text: string }).text, /用法/);
});

test("runPiCommand 降级命令 → handled 提示", async () => {
	for (const cmd of ["logout", "settings", "export", "quit", "fork", "tree"]) {
		const res = await runPiCommand(makeDeps(), {
			key: "k1",
			command: cmd,
			args: [],
			rawText: `/${cmd}`,
		});
		assert.equal(res.kind, "handled", `${cmd} 应 handled`);
	}
});

test("resolveSelect: 编号/label/模糊匹配", () => {
	const options = [
		{ index: 1, label: "anthropic/claude-sonnet", value: "claude-sonnet" },
		{ index: 2, label: "openai/gpt-4o", value: "gpt-4o" },
	];
	assert.equal(resolveSelect("2", options), "gpt-4o");
	assert.equal(resolveSelect("openai/gpt-4o", options), "gpt-4o");
	assert.equal(resolveSelect("gpt", options), "gpt-4o");
	assert.equal(resolveSelect("99", options), undefined);
	assert.equal(resolveSelect("zzz", options), undefined);
});

test("THINKING_LEVELS 覆盖 pi 全部等级", () => {
	assert.deepEqual(
		[...THINKING_LEVELS],
		["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	);
});
