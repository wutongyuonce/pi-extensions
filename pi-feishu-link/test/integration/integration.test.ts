// Integration tests (spec §10.2): full pipeline with fakes — inbound →
// conversation prompt → event forwarder → outbox → transport, plus the
// kill -9 consistency scenario (restart replay, exactly-once delivery).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationManager } from "../../src/sessions/conversation-manager.ts";
import { EventForwarder } from "../../src/outbound/event-forwarder.ts";
import { Outbox } from "../../src/outbound/outbox.ts";
import { OutboundRouter } from "../../src/outbound/outbound-router.ts";
import type {
	PiSessionHandle,
	SessionBackend,
} from "../../src/sessions/conversation-manager.ts";
import type {
	ForwardConfig,
	FeishuInboundMessage,
	RouteRef,
} from "../../src/common/types.ts";
import { DEFAULT_CONFIG } from "../../src/common/config.ts";

const FORWARD: ForwardConfig = DEFAULT_CONFIG.forward;

class EchoHandle implements PiSessionHandle {
	sessionId = `s-${Math.random().toString(36).slice(2)}`;
	lastPrompt = "";
	sessionFile: string;
	constructor(sessionFile: string) {
		this.sessionFile = sessionFile;
	}
	async prompt(text: string): Promise<void> {
		this.lastPrompt = text;
	}
	subscribe(): () => void {
		return () => {};
	}
	getLastAssistantText(): string {
		return `echo:${this.lastPrompt}`;
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
	async dispose(): Promise<void> {}
}

class EchoBackend implements SessionBackend {
	private readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}
	async createSession(opts: {
		cwd: string;
		sessionFile?: string;
	}): Promise<PiSessionHandle> {
		const file =
			opts.sessionFile ??
			join(this.dir, `sess-${Math.random().toString(36).slice(2)}.jsonl`);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(file, "", "utf8");
		return new EchoHandle(file);
	}
	async listSessions(): Promise<never[]> {
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

class FakeFeishuSender {
	sent: Array<{ type: string; to: string; text?: string; card?: unknown }> = [];
	async sendTo(
		route: RouteRef,
		payload: { type: string; text?: string; card?: unknown },
	): Promise<{ messageId: string }> {
		this.sent.push({
			type: payload.type,
			to: route.chatId,
			text: payload.text,
			card: payload.card,
		});
		return { messageId: `out-${this.sent.length}` };
	}
}

/** Minimal index.ts-like wiring with fakes. */
function buildHarness(dir: string) {
	const router = new OutboundRouter(join(dir, "routes.json"));
	const sender = new FakeFeishuSender();
	const conversations = new ConversationManager({
		cwd: "/work",
		backend: new EchoBackend(dir),
		stateFile: join(dir, "state.json"),
		maxResident: 4,
		idleDisposeMs: 60_000,
	});
	const outbox = new Outbox({
		dir: join(dir, "outbox"),
		sender: async (env) => {
			const p = env.payload as { type: string; text?: string; card?: unknown };
			return sender.sendTo(env.route, p);
		},
		maxAttemptsBeforeAlert: 3,
		sentRetentionMs: 60_000,
		maxPendingEnvelopes: 100,
		maxEnvelopeBytes: 4096,
		maxOutboxDirBytes: 10_000_000,
		compactIntervalMs: 0,
		backoffBaseMs: 5,
	});
	const forwarder = new EventForwarder({
		getConfig: () => FORWARD,
		enqueue: (partial) => outbox.enqueue(partial),
		liveDelta: () => {},
		liveContent: () => {},
	});
	return { router, sender, conversations, outbox, forwarder };
}

function inbound(
	chatId = "oc_1",
	user = "ou_1",
	text = "hello",
): FeishuInboundMessage {
	return {
		messageId: `om_${Date.now()}_${Math.random().toString(36).slice(2)}`,
		chatId,
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: user,
		senderType: "user",
		msgType: "text",
		content: JSON.stringify({ text }),
		timestamp: Date.now(),
	};
}

test("end-to-end: inbound → prompt → final → outbox → feishu reply", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-int-"));
	try {
		const { router, sender, conversations, outbox, forwarder } =
			buildHarness(dir);
		await outbox.init();
		const msg = inbound();
		const key = `p2p:${msg.senderOpenId}`;
		router.bindConversation(key, msg);
		const routeRef = router.getRoute(key)!;
		const route: RouteRef = {
			conversationKey: key,
			chatId: routeRef.chatId,
			chatType: routeRef.chatType,
			threadMessageId: routeRef.threadMessageId,
		};

		const finalText = await conversations.prompt(key, "hello", {
			turnTimeoutMs: 5000,
			ackAfterMs: 0,
		});
		await forwarder.handle(
			{ type: "turn_end", finalText, assistantMsgId: "msg-1" },
			{
				key,
				route,
				sessionId: conversations.peekSessionId(key) ?? "",
				runId: "r1",
			},
		);
		await outbox.drainIdle();
		assert.equal(sender.sent.length, 1);
		assert.equal(sender.sent[0]?.type, "text");
		assert.equal(sender.sent[0]?.text, "echo:hello");
		assert.equal(sender.sent[0]?.to, "oc_1");
		await conversations.disposeAll();
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("kill -9 consistency: pending final survives restart and delivers exactly once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-int-"));
	try {
		const opts = {
			dir: join(dir, "outbox"),
			sender: async () => ({ messageId: "out" }),
			maxAttemptsBeforeAlert: 3,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 4096,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 5,
		};
		// Instance A: enqueue a final but "crash" before the worker drains.
		const a = new Outbox({
			...opts,
			sender: async () => {
				throw new Error("process killed mid-send");
			},
		});
		await a.init();
		await a.enqueue({
			dedupeKey: "final:sess-1:msg-1",
			laneKey: "k",
			route: { conversationKey: "k", chatId: "oc_1", chatType: "p2p" },
			kind: "final",
			payload: { type: "text", text: "必须送达的消息" },
		});
		// Crash: no drain, just abandon.
		await a.close();

		// Instance B (restart): same dir, sender works → delivers exactly once.
		let deliveries = 0;
		const b = new Outbox({
			...opts,
			sender: async () => {
				deliveries++;
				return { messageId: "out" };
			},
		});
		await b.init();
		await b.drainIdle();
		assert.equal(deliveries, 1, "exactly once across restart");
		assert.equal(b.summary().sent, 1);

		// Restart again → dedupeKey prevents re-delivery.
		const c = new Outbox({
			...opts,
			sender: async () => {
				deliveries++;
				return { messageId: "out" };
			},
		});
		await c.init();
		await c.drainIdle();
		assert.equal(deliveries, 1, "no duplicate after second restart");
		await b.close();
		await c.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("per-lane isolation: a stuck lane does not delay another conversation's final", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-int-"));
	try {
		const delivered: string[] = [];
		const outbox = new Outbox({
			dir: join(dir, "outbox"),
			sender: async (env) => {
				if (env.laneKey === "stuck") throw new Error("feishu 5xx (retryable)");
				delivered.push((env.payload as { text: string }).text);
				return {};
			},
			maxAttemptsBeforeAlert: 2,
			sentRetentionMs: 60_000,
			maxPendingEnvelopes: 100,
			maxEnvelopeBytes: 4096,
			maxOutboxDirBytes: 10_000_000,
			compactIntervalMs: 0,
			backoffBaseMs: 10,
		});
		await outbox.init();
		await outbox.enqueue({
			dedupeKey: "final:stuck:1",
			laneKey: "stuck",
			route: { conversationKey: "stuck", chatId: "oc_s", chatType: "group" },
			kind: "final",
			payload: { type: "text", text: "stuck-msg" },
		});
		await outbox.enqueue({
			dedupeKey: "final:ok:1",
			laneKey: "ok",
			route: { conversationKey: "ok", chatId: "oc_o", chatType: "p2p" },
			kind: "final",
			payload: { type: "text", text: "ok-msg" },
		});
		// ok lane must deliver even though stuck lane retries forever.
		const deadline = Date.now() + 8000;
		while (delivered.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.deepEqual(delivered, ["ok-msg"]);
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scheduler marker → route → outbox delivers to bound chat (M6 loop)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-int-"));
	try {
		const { router, sender, outbox } = buildHarness(dir);
		await outbox.init();
		// Bind a conversation route, then a job to it.
		const msg = inbound("oc_job");
		router.bindConversation("p2p:ou_1", msg);
		router.bindJob("job-9", "p2p:ou_1", "每日报告");
		// Direct outbox enqueue with kind=scheduled (as BridgeRuntime would do).
		await outbox.enqueue({
			dedupeKey: "assistant:job-9:msg-x",
			laneKey: "p2p:ou_1",
			route: { conversationKey: "p2p:ou_1", chatId: "oc_job", chatType: "p2p" },
			kind: "scheduled",
			payload: { type: "text", text: "今日 commit 3 个" },
		});
		await outbox.drainIdle();
		assert.equal(sender.sent.length, 1);
		assert.equal(sender.sent[0]?.to, "oc_job");
		assert.equal(sender.sent[0]?.text, "今日 commit 3 个");
		await outbox.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
