import test from "node:test";
import assert from "node:assert/strict";
import { NotificationThrottler } from "../../../src/sessions/notification-throttler.ts";
import type { NotificationEvent } from "../../../src/common/types.ts";

function makeThrottler(windowMs = 100) {
	let now = 1000;
	const sent: Array<{ events: NotificationEvent[]; summary?: string }> = [];
	const throttler = new NotificationThrottler({
		mergeWindowMs: windowMs,
		now: () => now,
		onSend: (events, summary) => sent.push({ events, summary }),
	});
	return {
		throttler,
		sent,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function notif(
	type: string,
	severity: NotificationEvent["severity"] = "info",
	seq = 1,
): NotificationEvent {
	return {
		id: `${type}-${seq}`,
		severity,
		type,
		message: `${type} message ${seq}`,
		createdAt: 1000,
	};
}

test("first info notification sends immediately; duplicates merge into summary", async () => {
	const { throttler, sent } = makeThrottler(100);
	throttler.submit(notif("reconnect"));
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.events.length, 1);
	throttler.submit(notif("reconnect", "info", 2));
	throttler.submit(notif("reconnect", "info", 3));
	assert.equal(sent.length, 1, "duplicates merged, nothing sent yet");
	// Window ends → summary with total count.
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(sent.length, 2);
	const last = sent[1];
	assert.ok(last?.summary, "summary produced for merged duplicates");
	assert.ok(last.summary!.includes("3"));
});

test("different types are throttled independently", async () => {
	const { throttler, sent } = makeThrottler(100);
	throttler.submit(notif("reconnect"));
	throttler.submit(notif("timeout"));
	assert.equal(sent.length, 2, "each first-of-type sends immediately");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(sent.length, 2, "no summary without duplicates");
});

test("critical notifications bypass merging", () => {
	const { throttler, sent } = makeThrottler(100);
	throttler.submit(notif("reconnect", "info", 1));
	throttler.submit(notif("reconnect", "critical", 2));
	assert.equal(sent.length, 2, "critical went straight through");
});

test("flush emits pending summaries immediately", () => {
	const { throttler, sent } = makeThrottler(10_000);
	throttler.submit(notif("reconnect", "info", 1));
	throttler.submit(notif("reconnect", "info", 2));
	assert.equal(sent.length, 1);
	throttler.flush();
	assert.equal(sent.length, 2);
	assert.ok(sent[1]?.summary?.includes("2"));
	// flush again → nothing pending
	throttler.flush();
	assert.equal(sent.length, 2);
});

test("stop clears timers", () => {
	const { throttler, sent } = makeThrottler(100);
	throttler.submit(notif("reconnect"));
	throttler.stop();
	assert.equal(sent.length, 1);
	assert.equal(throttler.pendingWindows(), 0);
});
