import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationManager } from "../../../src/sessions/conversation-manager.ts";
import { TurnSupervisor } from "../../../src/sessions/turn-supervisor.ts";
import type {
	PiSessionHandle,
	SessionBackend,
	SessionListItem,
} from "../../../src/sessions/conversation-manager.ts";

class FakeHandle implements PiSessionHandle {
	sessionId = `sid-${Math.random().toString(36).slice(2)}`;
	lastPrompt = "";
	sessionFile: string;
	/** 2026-08-08 持续订阅测试：保存 subscribe 回调。 */
	subscriber: ((e: unknown) => void) | undefined;
	/** 2026-08-08：holdPrompt=true 时 prompt 挂起直到 releasePrompt。 */
	holdPrompt = false;
	private promptResolve: (() => void) | undefined;
	constructor(sessionFile: string) {
		this.sessionFile = sessionFile;
	}
	async prompt(text: string): Promise<void> {
		this.lastPrompt = text;
		if (this.holdPrompt) {
			await new Promise<void>((r) => {
				this.promptResolve = r;
			});
		}
	}
	releasePrompt(): void {
		this.promptResolve?.();
		this.promptResolve = undefined;
	}
	subscribe(fn: (e: unknown) => void): () => void {
		this.subscriber = fn;
		return () => {
			this.subscriber = undefined;
		};
	}
	/** 模拟会话事件（text_delta）。 */
	emitDelta(delta: string): void {
		this.subscriber?.({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta },
		});
	}
	/** 2026-08-08：模拟 message_end（每轮完整输出）。 */
	emitMessageEnd(text: string, role: string): void {
		this.subscriber?.({
			type: "message_end",
			message: { role, content: text },
		});
	}
	getLastAssistantText(): string {
		return `answer:${this.lastPrompt}`;
	}
	getModelLabel(): string {
		return "fake";
	}
	async setModel(_modelId: string): Promise<boolean> {
		return true;
	}
	async cycleModel(): Promise<string | undefined> {
		return undefined;
	}
	async setThinkingLevel(): Promise<void> {}
	getThinkingLevel(): string {
		return "off";
	}
	getAvailableThinkingLevels(): string[] {
		return ["off"];
	}
	async compact(): Promise<string> {
		return "compacted";
	}
	async setSessionName(): Promise<void> {}
	getSessionSummary() {
		return { modelId: "fake", messageCount: 0 };
	}
	async executeBash(): Promise<string> {
		return "";
	}
	async dispose(): Promise<void> {
		disposed.push(this.sessionId);
	}
}

const disposed: string[] = [];
const created: Array<{ cwd: string; modelId?: string }> = [];
const handles = new Map<string, FakeHandle>();

class FakeBackend implements SessionBackend {
	async createSession(opts: {
		cwd: string;
		modelId?: string;
		sessionFile?: string;
	}): Promise<PiSessionHandle> {
		created.push({ cwd: opts.cwd, modelId: opts.modelId });
		const file = opts.sessionFile ?? join(dir, `sess-${created.length}.jsonl`);
		writeFileSync(file, "", "utf8");
		const h = new FakeHandle(file);
		handles.set(h.sessionId, h);
		return h;
	}
	async listSessions(_cwd?: string): Promise<SessionListItem[]> {
		return [];
	}
	async listModels() {
		return [
			{
				provider: "fake",
				id: "fake-model",
				contextWindow: 0,
				reasoning: false,
			},
		];
	}
}

let dir: string;

function freshManager(
	overrides: Partial<ConstructorParameters<typeof ConversationManager>[0]> = {},
) {
	dir = mkdtempSync(join(tmpdir(), "fb-cm-"));
	const stateFile = join(dir, "state.json");
	created.length = 0;
	disposed.length = 0;
	handles.clear();
	const mgr = new ConversationManager({
		cwd: "/work/default",
		backend: new FakeBackend(),
		stateFile,
		maxResident: 2,
		idleDisposeMs: 10_000,
		...overrides,
	});
	return mgr;
}

test("prompt creates session lazily and returns final text", async () => {
	const mgr = freshManager();
	try {
		const answer = await mgr.prompt("k", "hello", {
			turnTimeoutMs: 1000,
			ackAfterMs: 0,
		});
		assert.equal(answer, "answer:hello");
		assert.equal(created.length, 1);
		assert.equal(created[0]?.cwd, "/work/default");
		assert.equal(mgr.residentCount(), 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FIFO per key: second prompt waits for first", async () => {
	const mgr = freshManager();
	try {
		const order: string[] = [];
		const p1 = mgr
			.prompt("k", "first", { turnTimeoutMs: 1000, ackAfterMs: 0 })
			.then((a) => {
				order.push(a);
				return a;
			});
		const p2 = mgr
			.prompt("k", "second", { turnTimeoutMs: 1000, ackAfterMs: 0 })
			.then((a) => {
				order.push(a);
				return a;
			});
		await Promise.all([p1, p2]);
		assert.deepEqual(order, ["answer:first", "answer:second"]);
		assert.equal(created.length, 1, "same session reused");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("different keys get independent sessions", async () => {
	const mgr = freshManager();
	try {
		await mgr.prompt("a", "x", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		await mgr.prompt("b", "y", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		assert.equal(created.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("newConversation disposes old and starts fresh", async () => {
	const mgr = freshManager();
	try {
		await mgr.prompt("k", "a", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		const before = disposed.length;
		await mgr.newConversation("k");
		assert.equal(disposed.length, before + 1);
		await mgr.prompt("k", "b", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		assert.equal(created.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("switchWorkspace disposes and binds new cwd; session files isolated", async () => {
	const mgr = freshManager();
	try {
		const ws1 = realpathSync(mkdtempSync(join(tmpdir(), "fb-ws1-")));
		const ws2 = realpathSync(mkdtempSync(join(tmpdir(), "fb-ws2-")));
		await mgr.prompt("k", "a", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		const file1 = await mgr.getSessionFile("k");
		await mgr.switchWorkspace("k", ws2);
		await mgr.prompt("k", "b", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		const file2 = await mgr.getSessionFile("k");
		assert.notEqual(
			file1,
			file2,
			"session file must differ after workspace switch",
		);
		assert.ok(created.some((c) => c.cwd === ws2));
		assert.equal(mgr.getWorkspace("k"), ws2);
		assert.equal(
			mgr.sessionDirFor("k", ws1) === mgr.sessionDirFor("k", ws2),
			false,
		);
		rmSync(ws1, { recursive: true, force: true });
		rmSync(ws2, { recursive: true, force: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("evictIdle disposes idle sessions and enforces maxResident", async () => {
	let now = 0;
	const mgr = freshManager({ now: () => now });
	try {
		await mgr.prompt("a", "x", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		now += 1000;
		await mgr.prompt("b", "y", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		now += 1000;
		await mgr.prompt("c", "z", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		assert.equal(created.length, 3);
		// maxResident=2: at most 2 sessions stay resident after eviction.
		await mgr.evictIdle(now);
		assert.ok(
			mgr.residentCount() <= 2,
			`expected <=2 resident, got ${mgr.residentCount()}`,
		);
		// Age everything beyond idleDisposeMs → all idle sessions disposed.
		now += 11_000;
		await mgr.evictIdle(now);
		assert.equal(mgr.residentCount(), 0);
		// Sessions were actually disposed (not just removed from the map).
		assert.ok(disposed.length >= 3, "all three sessions disposed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selectModel disposes and binds model", async () => {
	const mgr = freshManager();
	try {
		await mgr.prompt("k", "a", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		await mgr.selectModel("k", "gpt-5");
		assert.equal(mgr.getModel("k"), "gpt-5");
		await mgr.prompt("k", "b", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		assert.ok(created.some((c) => c.modelId === "gpt-5"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("state persists across instances", async () => {
	const mgr = freshManager();
	try {
		await mgr.prompt("k", "a", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		await mgr.selectModel("k", "gpt-5");
		const stateFile = mgr["stateFile"];
		const mgr2 = new ConversationManager({
			cwd: "/work/default",
			backend: new FakeBackend(),
			stateFile,
			maxResident: 2,
			idleDisposeMs: 10_000,
		});
		assert.equal(mgr2.getModel("k"), "gpt-5");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("I1: a failed prompt does not poison the FIFO queue", async () => {
	const mgr = freshManager();
	// Swap the backend handle so the first prompt throws.
	const failing = new FakeHandle(join(dir, "fail.jsonl"));
	failing.prompt = async () => {
		throw new Error("model exploded");
	};
	const realCreate = mgr["backend"].createSession.bind(mgr["backend"]);
	let failingServed = 0;
	mgr["backend"].createSession = async (opts) => {
		if (failingServed++ === 0) return failing;
		return realCreate(opts);
	};
	try {
		await assert.rejects(
			mgr.prompt("k", "boom", { turnTimeoutMs: 1000, ackAfterMs: 0 }),
			/model exploded/,
		);
		// The queue tail must recover: the next message processes normally.
		const answer = await mgr.prompt("k", "after", {
			turnTimeoutMs: 1000,
			ackAfterMs: 0,
		});
		assert.ok(answer.startsWith("answer:after"), `got ${answer}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("I1: watchdog is cleared after a failed prompt", async () => {
	const ts = new TurnSupervisor({
		onTimeout: async () => undefined,
		onAck: async () => undefined,
		onQueueWarn: async () => undefined,
	});
	const mgr = freshManager({ turnSupervisor: ts });
	const failing = new FakeHandle(join(dir, "fail.jsonl"));
	failing.prompt = async () => {
		throw new Error("boom");
	};
	const realCreate = mgr["backend"].createSession.bind(mgr["backend"]);
	let failingServed = 0;
	mgr["backend"].createSession = async (opts) => {
		if (failingServed++ === 0) return failing;
		return realCreate(opts);
	};
	try {
		await assert.rejects(
			mgr.prompt("k", "boom", { turnTimeoutMs: 1000, ackAfterMs: 0 }),
		);
		// A subsequent turn is supervised (beginTurn registers a fresh active turn).
		await mgr.prompt("k", "after", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		assert.equal(ts.isTurnActive("k"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("C3: keyForSessionId resolves the conversation for a bridge session", async () => {
	const mgr = freshManager();
	try {
		await mgr.prompt("p2p:ou_1", "hi", { turnTimeoutMs: 1000, ackAfterMs: 0 });
		const sid = mgr.peekSessionId("p2p:ou_1");
		assert.ok(sid);
		assert.equal(mgr.keyForSessionId(sid!), "p2p:ou_1");
		assert.equal(mgr.keyForSessionId("nope"), undefined);
		// Not forced: keys without a resident handle resolve to undefined.
		assert.equal(mgr.keyForSessionId("sid-fake"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("queued message triggers queueWarn tracking while a turn is active", async () => {
	const marked: string[] = [];
	const ts = new (class extends TurnSupervisor {
		constructor() {
			super({
				onTimeout: async () => undefined,
				onAck: async () => undefined,
				onQueueWarn: async () => undefined,
			});
		}
		override markQueued(key: string): void {
			marked.push(key);
			super.markQueued(key);
		}
	})();
	const mgr = freshManager({ turnSupervisor: ts });
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const slow = new FakeHandle(join(dir, "slow.jsonl"));
	slow.prompt = async () => {
		await gate;
	};
	const realCreate = mgr["backend"].createSession.bind(mgr["backend"]);
	mgr["backend"].createSession = async (opts) => {
		if (created.length === 0) return slow;
		return realCreate(opts);
	};
	try {
		const p1 = mgr.prompt("k", "first", { turnTimeoutMs: 5000, ackAfterMs: 0 });
		// Give the first turn time to start, then enqueue a second message.
		await new Promise((r) => setTimeout(r, 20));
		const p2 = mgr.prompt("k", "second", {
			turnTimeoutMs: 5000,
			ackAfterMs: 0,
		});
		await new Promise((r) => setTimeout(r, 20));
		assert.ok(ts.isTurnActive("k"));
		assert.ok(marked.includes("k"), "second message was marked queued");
		release();
		await p1;
		await p2;
		assert.ok(!ts.isTurnActive("k"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("持续订阅：每轮 assistant 完整输出（message_end）逐条转发（2026-08-08）", async () => {
	dir = mkdtempSync(join(tmpdir(), "fb-cm-live-"));
	const stateFile = join(dir, "state.json");
	created.length = 0;
	disposed.length = 0;
	handles.clear();
	const msgs: Array<{ key: string; text: string }> = [];
	const mgr = new ConversationManager({
		cwd: "/work/default",
		backend: new FakeBackend(),
		stateFile,
		maxResident: 4,
		onAssistantMessage: (key, text) => msgs.push({ key, text }),
	});
	try {
		const handle = (await mgr.getHandle("k1")) as FakeHandle;
		assert.ok(handle.subscriber, "会话创建后应挂持续订阅");
		// 每轮 assistant 完整输出（message_end）→ 转发
		handle.emitMessageEnd("第一轮输出", "assistant");
		handle.emitMessageEnd("第二轮输出", "assistant");
		assert.equal(msgs.length, 2);
		assert.equal(msgs[0]?.text, "第一轮输出");
		assert.equal(msgs[1]?.text, "第二轮输出");
		assert.equal(msgs[0]?.key, "k1");
		// 非 assistant（user/toolResult）不转发
		handle.emitMessageEnd("用户消息", "user");
		handle.emitMessageEnd("工具结果", "toolResult");
		assert.equal(msgs.length, 2);
		// 空输出跳过（工具调用轮无文本）
		handle.emitMessageEnd("", "assistant");
		assert.equal(msgs.length, 2);
		// 非 message_end 事件不转发
		handle.emitDelta("流式delta");
		assert.equal(msgs.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
