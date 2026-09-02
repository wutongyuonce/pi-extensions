import test from "node:test";
import assert from "node:assert/strict";
import { BridgeRuntime } from "../../../src/sessions/bridge-runtime.ts";
import type { Route } from "../../../src/common/types.ts";

function makeRuntime() {
	const routes = new Map<string, Route>();
	const sent = new Set<string>();
	const enqueued: Array<{
		kind: string;
		laneKey: string;
		text?: string;
		dedupeKey: string;
	}> = [];
	const bound: Array<{ jobId: string; key: string; name?: string }> = [];
	const runtime = new BridgeRuntime({
		resolveJobRoute: (jobId) => routes.get(jobId),
		enqueue: async (partial) => {
			const p = partial.payload as { type: "text"; text: string };
			enqueued.push({
				kind: partial.kind,
				laneKey: partial.laneKey,
				text: p.text,
				dedupeKey: partial.dedupeKey,
			});
			return {};
		},
		hasSent: (k) => sent.has(k),
		markSent: (k) => {
			sent.add(k);
		},
		bindJob: (jobId, key, name) => {
			bound.push({ jobId, key, name });
		},
	});
	routes.set("job-1", {
		sessionKey: "k1",
		chatId: "oc_1",
		chatType: "p2p",
		updatedAt: Date.now(),
	});
	return { runtime, routes, sent, enqueued, bound };
}

test("schedule_prompt add captures jobs only for feishu inputs", () => {
	const { runtime, bound } = makeRuntime();
	runtime.beginFeishuInput("k1");
	const consumed = runtime.handleMessageEnd("sess-1", "k1", {
		role: "toolResult",
		toolName: "schedule_prompt",
		details: {
			action: "add",
			jobs: [{ id: "job-1", name: "每日报告" }, { id: "job-2" }],
		},
	});
	assert.equal(consumed, true);
	assert.equal(bound.length, 2);
	assert.equal(bound[0]?.name, "每日报告");
});

test("scheduled marker + assistant result delivers to bound route once", async () => {
	const { runtime, enqueued } = makeRuntime();
	runtime.beginFeishuInput("k1");
	runtime.handleMessageEnd("sess-1", "k1", {
		role: "custom",
		customType: "scheduled_prompt",
		details: { jobId: "job-1", jobName: "每日报告" },
		id: "marker-1",
	});
	const consumed = runtime.handleMessageEnd("sess-1", "k1", {
		role: "assistant",
		content: [{ type: "text", text: "今日 commit 3 个" }],
		id: "msg-9",
	});
	assert.equal(consumed, true);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(enqueued.length, 1);
	assert.equal(enqueued[0]?.kind, "scheduled");
	assert.equal(enqueued[0]?.text, "今日 commit 3 个");
	assert.equal(enqueued[0]?.laneKey, "k1");
	assert.ok(enqueued[0]?.dedupeKey.startsWith("assistant:job-1:"));
	// Replay of the same message is deduped.
	runtime.handleMessageEnd("sess-1", "k1", {
		role: "assistant",
		content: "今日 commit 3 个",
		id: "msg-9",
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(enqueued.length, 1);
});

test("subagent_done marker delivers directly", async () => {
	const { runtime, enqueued } = makeRuntime();
	runtime.beginFeishuInput("k1");
	runtime.handleMessageEnd("sess-1", "k1", {
		role: "custom",
		customType: "scheduled_prompt",
		details: { jobId: "job-1", mode: "subagent_done", output: "任务完成" },
		id: "m2",
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(enqueued.length, 1);
	assert.equal(enqueued[0]?.text, "任务完成");
});

test("unknown job id is skipped without enqueue", async () => {
	const { runtime, enqueued } = makeRuntime();
	runtime.beginFeishuInput("k1");
	runtime.handleMessageEnd("sess-1", "k1", {
		role: "custom",
		customType: "scheduled_prompt",
		details: { jobId: "job-missing" },
		id: "m3",
	});
	runtime.handleMessageEnd("sess-1", "k1", {
		role: "assistant",
		content: "hello",
		id: "m4",
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(enqueued.length, 0);
});

test("isFeishuInput tracks active inputs", () => {
	const { runtime } = makeRuntime();
	runtime.beginFeishuInput("key-s");
	assert.equal(runtime.isFeishuInput("key-s"), true);
	runtime.endFeishuInput("key-s");
	assert.equal(runtime.isFeishuInput("key-s"), false);
});

test("C3: jobs are captured only when the sessionKey is an active feishu input", () => {
	const { runtime, bound } = makeRuntime();
	// No beginFeishuInput → capture must bail even with a sessionKey.
	runtime.handleMessageEnd("sess-1", "k1", {
		role: "toolResult",
		toolName: "schedule_prompt",
		details: { action: "add", jobs: [{ id: "job-1" }] },
	});
	assert.equal(bound.length, 0, "inactive input must not bind jobs");
	// Undefined sessionKey (TUI sessions) must never bind either.
	runtime.beginFeishuInput("k1");
	runtime.handleMessageEnd("sess-1", undefined, {
		role: "toolResult",
		toolName: "schedule_prompt",
		details: { action: "add", jobs: [{ id: "job-1" }] },
	});
	assert.equal(bound.length, 0, "undefined sessionKey must not bind jobs");
	// Active + key → binds.
	runtime.handleMessageEnd("sess-1", "k1", {
		role: "toolResult",
		toolName: "schedule_prompt",
		details: { action: "add", jobs: [{ id: "job-1" }] },
	});
	assert.equal(bound.length, 1);
});
