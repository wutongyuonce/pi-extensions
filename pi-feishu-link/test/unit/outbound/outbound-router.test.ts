import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OutboundRouter,
	DELIVERY_SENT_TTL_MS,
	JOB_TTL_MS,
} from "../../../src/outbound/outbound-router.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "feishu-link-router-"));
	return join(dir, "routes.json");
}

function msg(
	overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage {
	return {
		messageId: "om_1",
		chatId: "oc_1",
		chatType: "group",
		chatMode: "group",
		senderOpenId: "ou_1",
		senderType: "user",
		msgType: "text",
		content: JSON.stringify({ text: "hi" }),
		timestamp: Date.now(),
		...overrides,
	};
}

test("bindConversation stores route and refresh keeps sessionId", () => {
	const p = tempFile();
	try {
		const router = new OutboundRouter(p);
		const r1 = router.bindConversation("key-1", msg());
		assert.equal(r1.chatId, "oc_1");
		assert.equal(r1.threadMessageId, undefined);
		const r2 = router.bindConversation(
			"key-1",
			msg({ messageId: "om_2" }),
			"sess-9",
		);
		assert.equal(r2.sessionId, "sess-9");
		assert.equal(r2.lastMessageId, "om_2");
		assert.equal(router.getRoute("key-1")?.sessionId, "sess-9");
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("threadMessageId: replies follow the thread; topics anchor to the message", () => {
	const p = tempFile();
	try {
		const router = new OutboundRouter(p);
		const root = router.bindConversation(
			"t",
			msg({ rootId: "root-1", parentId: "parent-1" }),
		);
		assert.equal(root.threadMessageId, "root-1");
		// Follow-up without thread markers keeps the previous thread anchor.
		const follow = router.bindConversation("t", msg({ messageId: "om_2" }));
		assert.equal(follow.threadMessageId, "root-1");
		const topic = router.bindConversation(
			"topic-k",
			msg({ threadId: "thread-x", chatMode: "topic" }),
		);
		assert.equal(topic.threadMessageId, "om_1");
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("bindJob + getJob + resolve by jobId", () => {
	const p = tempFile();
	try {
		const router = new OutboundRouter(p);
		router.bindConversation("key-1", msg());
		const job = router.bindJob("job-42", "key-1", "每日报告");
		assert.ok(job);
		assert.equal(job.jobId, "job-42");
		assert.equal(job.chatId, "oc_1");
		assert.equal(router.getJob("job-42")?.jobName, "每日报告");
		assert.equal(router.resolve("job-42")?.chatId, "oc_1");
		assert.equal(router.resolve("key-1")?.chatId, "oc_1");
		assert.equal(router.boundJobCount(), 1);
		// bindJob without a route → undefined
		assert.equal(router.bindJob("job-x", "missing-key"), undefined);
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("delivery dedupe: hasSent within TTL, prunes after", () => {
	const p = tempFile();
	try {
		const router = new OutboundRouter(p);
		router.markSent("deliver:job-1:msg-1");
		assert.equal(router.hasSent("deliver:job-1:msg-1"), true);
		assert.equal(router.hasSent("deliver:job-1:msg-2"), false);
		// Inject an expired key directly then prune.
		const state = JSON.parse(readFileSync(p, "utf8"));
		state.sent["old-key"] = Date.now() - DELIVERY_SENT_TTL_MS - 1;
		writeFileSync(p, JSON.stringify(state), "utf8");
		const reloaded = new OutboundRouter(p);
		assert.equal(reloaded.hasSent("old-key"), false);
		reloaded.pruneSent();
		assert.equal(
			Object.keys(reloaded["state"].sent).includes("old-key"),
			false,
		);
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("persists across instances", () => {
	const p = tempFile();
	try {
		const a = new OutboundRouter(p);
		a.bindConversation("k", msg());
		a.bindJob("j1", "k", "job");
		const b = new OutboundRouter(p);
		assert.equal(b.getRoute("k")?.chatId, "oc_1");
		assert.equal(b.getJob("j1")?.jobName, "job");
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("M9: stale job routes are pruned", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-router-"));
	try {
		const file = join(dir, "routes.json");
		const router = new OutboundRouter(file);
		router.bindConversation("k1", msg());
		router.bindJob("job-old", "k1", "旧任务");
		// Age the job binding beyond the TTL by mutating the persisted file.
		const state = JSON.parse(readFileSync(file, "utf8"));
		state.jobs["job-old"].updatedAt = Date.now() - JOB_TTL_MS - 1000;
		writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
		const router2 = new OutboundRouter(file); // re-read → pruneJobs on boot
		assert.equal(router2.getJob("job-old"), undefined, "stale job pruned");
		router2.bindJob("job-new", "k1", "新任务");
		assert.ok(router2.getJob("job-new"), "fresh job kept");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
