import test from "node:test";
import assert from "node:assert/strict";
import { LiveChannel } from "../../../src/outbound/live-channel.ts";

test("deltas are coalesced and throttled per card", async () => {
	const now = 0;
	const sent: Array<{ cardId: string; delta?: string }> = [];
	const ch = new LiveChannel({
		throttleMs: 100,
		send: async (p) => {
			sent.push({ cardId: p.cardId, delta: p.delta });
		},
		now: () => now,
	});
	ch.patchDelta("c1", "a");
	ch.patchDelta("c1", "b");
	ch.patchDelta("c1", "c");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(sent.length, 1, "coalesced into a single send");
	assert.equal(sent[0]?.delta, "abc");
	ch.stop();
});

test("separate cards are not coalesced together", async () => {
	const sent: string[] = [];
	const ch = new LiveChannel({
		throttleMs: 50,
		send: async (p) => {
			sent.push(`${p.cardId}:${p.delta ?? ""}`);
		},
	});
	ch.patchDelta("a", "1");
	ch.patchDelta("b", "2");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(sent.length, 2);
	assert.ok(sent.some((s) => s === "a:1"));
	assert.ok(sent.some((s) => s === "b:2"));
	ch.stop();
});

test("flushCard sends immediately even under throttle", async () => {
	const now = 0;
	const sent: string[] = [];
	const ch = new LiveChannel({
		throttleMs: 10_000,
		send: async (p) => {
			sent.push(p.delta ?? "");
		},
		now: () => now,
	});
	ch.patchDelta("c", "partial");
	await ch.flushCard("c");
	assert.deepEqual(sent, ["partial"]);
	ch.stop();
});

test("failed sends are dropped silently (volatile channel)", async () => {
	const ch = new LiveChannel({
		throttleMs: 10,
		send: async () => {
			throw new Error("feishu 5xx");
		},
	});
	ch.patchDelta("c", "x");
	ch.patchContent("c", { status: "running" });
	await new Promise((r) => setTimeout(r, 50));
	await ch.flushAll();
	assert.ok(true, "no throw");
	ch.stop();
});

test("patchContent replaces content", async () => {
	const sent: Array<{ cardId: string; content?: unknown }> = [];
	const ch = new LiveChannel({
		throttleMs: 10,
		send: async (p) => {
			sent.push({ cardId: p.cardId, content: p.content });
		},
	});
	ch.patchContent("c", { phase: "running" });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]?.content, { phase: "running" });
	ch.stop();
});

test("I10: finalize flushes pending deltas then closes the card", async () => {
	const sent: Array<{ cardId: string; delta?: string; content?: unknown }> = [];
	const ch = new LiveChannel({
		throttleMs: 1_000_000, // huge throttle → nothing would flush on its own
		send: async (p) => {
			sent.push({ cardId: p.cardId, delta: p.delta, content: p.content });
		},
	});
	ch.patchDelta("c", "你");
	ch.patchDelta("c", "好");
	await ch.finalize("c");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.delta, "你好");
	// After finalize, later patches are dropped (they would clobber the durable final).
	ch.patchDelta("c", "残留");
	await ch.flushAll();
	assert.equal(sent.length, 1, "closed card must not emit further patches");
	ch.stop();
});

test("flushCard still flushes an open card", async () => {
	const sent: Array<{ cardId: string; delta?: string }> = [];
	const ch = new LiveChannel({
		throttleMs: 1_000_000,
		send: async (p) => {
			sent.push({ cardId: p.cardId, delta: p.delta });
		},
	});
	ch.patchDelta("c", "hello");
	await ch.flushCard("c");
	assert.equal(sent.length, 1);
	ch.stop();
});
