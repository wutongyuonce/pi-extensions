import test from "node:test";
import assert from "node:assert/strict";
import {
	notifyOwner,
	notifyConversation,
	notifyConversationCard,
	notifyOwnerCard,
	routeToRef,
	type NotificationDeps,
} from "../../../src/application/notification-service.ts";
import type { Outbox } from "../../../src/outbound/outbox.js";
import type { OutboundRouter } from "../../../src/outbound/outbound-router.js";
import type { Route } from "../../../src/common/types.js";

function fakeRouter(routes: Record<string, Route>): OutboundRouter {
	return {
		routesSnapshot: () => routes,
		getRoute: (key: string) => routes[key],
	} as unknown as OutboundRouter;
}

function fakeOutbox(): { outbox: Outbox; enqueued: unknown[] } {
	const enqueued: unknown[] = [];
	return {
		outbox: {
			enqueue: async (env: unknown) => {
				enqueued.push(env);
			},
		} as unknown as Outbox,
		enqueued,
	};
}

const route: Route = {
	sessionKey: "p2p:ou_1",
	chatId: "oc_1",
	chatType: "p2p",
	threadMessageId: "om_1",
	lastMessageId: "om_0",
	updatedAt: 1,
};

test("routeToRef 带 route → 完整 RouteRef；无 route → fallback", () => {
	const ref = routeToRef(route, {
		chatId: "oc_fb",
		chatType: "p2p",
		threadMessageId: "om_fb",
	});
	assert.equal(ref.conversationKey, "p2p:ou_1");
	assert.equal(ref.chatId, "oc_1");
	assert.equal(ref.lastMessageId, "om_0");
	const fallback = routeToRef(undefined, {
		chatId: "oc_fb",
		chatType: "group",
		threadMessageId: "om_fb",
	});
	assert.equal(fallback.chatId, "oc_fb");
	assert.equal(fallback.conversationKey, "oc_fb");
});

test("notifyConversation 只发目标会话（text）", async () => {
	const { outbox, enqueued } = fakeOutbox();
	const deps: NotificationDeps = {
		outbox,
		router: fakeRouter({ "p2p:ou_1": route }),
	};
	await notifyConversation(deps, "p2p:ou_1", "你好");
	assert.equal(enqueued.length, 1);
	const e = enqueued[0] as {
		kind: string;
		laneKey: string;
		payload: { type: string; text: string };
	};
	assert.equal(e.kind, "notify");
	assert.equal(e.payload.type, "text");
	assert.equal(e.payload.text, "你好");
});

test("notifyOwner 广播所有会话；notifyOwnerCard 广播卡片", async () => {
	const { outbox, enqueued } = fakeOutbox();
	const deps: NotificationDeps = {
		outbox,
		router: fakeRouter({
			a: route,
			b: { ...route, sessionKey: "group:g", chatId: "oc_g" },
		}),
	};
	await notifyOwner(deps, "广播");
	assert.equal(enqueued.length, 2);
	const card = { schema: "2.0" };
	await notifyOwnerCard(deps, card);
	assert.equal(enqueued.length, 4);
	const last = enqueued[3] as { payload: { type: string; card: unknown } };
	assert.equal(last.payload.type, "card");
	assert.deepEqual(last.payload.card, card);
});

test("notifyConversationCard 发卡片到目标会话", async () => {
	const { outbox, enqueued } = fakeOutbox();
	const deps: NotificationDeps = {
		outbox,
		router: fakeRouter({ "p2p:ou_1": route }),
	};
	const card = { schema: "2.0", body: { elements: [] } };
	await notifyConversationCard(deps, "p2p:ou_1", card);
	assert.equal(enqueued.length, 1);
	const e = enqueued[0] as { payload: { type: string; card: unknown } };
	assert.equal(e.payload.type, "card");
	assert.deepEqual(e.payload.card, card);
});

test("无 outbox 时不抛错", async () => {
	const deps: NotificationDeps = {
		outbox: undefined,
		router: fakeRouter({ a: route }),
	};
	await notifyOwner(deps, "x");
	await notifyConversation(deps, "a", "x");
	await notifyOwnerCard(deps, {});
	await notifyConversationCard(deps, "a", {});
	assert.ok(true);
});
