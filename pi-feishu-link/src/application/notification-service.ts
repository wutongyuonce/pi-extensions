// DDD 应用层（spec 2026-08-08-1700 Step 2）：通知服务——notify* 从 index.ts
// 搬移，依赖参数化（outbox/router 注入），可单测。

import type { Outbox } from "../outbound/outbox.js";
import type { OutboundRouter } from "../outbound/outbound-router.js";
import type { Route, RouteRef } from "../common/types.js";

/** Route → RouteRef（含 fallback 构造）。 */
export function routeToRef(
	route: Route | undefined,
	fallback: {
		chatId: string;
		chatType: "p2p" | "group";
		threadMessageId?: string;
	},
): RouteRef {
	if (route) {
		return {
			conversationKey: route.sessionKey,
			chatId: route.chatId,
			chatType: route.chatType,
			threadMessageId: route.threadMessageId,
			lastMessageId: route.lastMessageId,
		};
	}
	return {
		conversationKey: fallback.chatId,
		chatId: fallback.chatId,
		chatType: fallback.chatType,
		threadMessageId: fallback.threadMessageId,
	};
}

export interface NotificationDeps {
	outbox?: Outbox;
	router: OutboundRouter;
}

/** 公共 enqueue（notify 结构去重，2026-08-08 简化）。 */
async function enqueueNotify(
	deps: NotificationDeps,
	ref: RouteRef,
	payload: { type: "text"; text: string } | { type: "card"; card: unknown },
): Promise<void> {
	if (!deps.outbox) return;
	try {
		await deps.outbox.enqueue({
			dedupeKey: `notify:${ref.conversationKey}:${Date.now()}`,
			laneKey: ref.conversationKey,
			route: ref,
			kind: "notify",
			payload,
		});
	} catch {
		/* best-effort */
	}
}

function routeRefOf(route: Route): RouteRef {
	return routeToRef(route, {
		chatId: route.chatId,
		chatType: route.chatType,
		threadMessageId: route.threadMessageId,
	});
}

/** 通知所有会话（owner 广播）。 */
export async function notifyOwner(
	deps: NotificationDeps,
	text: string,
): Promise<void> {
	for (const route of Object.values(deps.router.routesSnapshot())) {
		await enqueueNotify(deps, routeRefOf(route), {
			type: "text",
			text,
		});
	}
}

/** 通知单个会话（ack / queue-warn / timeout）。 */
export async function notifyConversation(
	deps: NotificationDeps,
	key: string,
	text: string,
): Promise<void> {
	const route = deps.router.getRoute(key);
	if (!route) return;
	await enqueueNotify(deps, routeRefOf(route), { type: "text", text });
}

/** 发送卡片到单个会话（审批卡等）。 */
export async function notifyConversationCard(
	deps: NotificationDeps,
	key: string,
	card: unknown,
): Promise<void> {
	const route = deps.router.getRoute(key);
	if (!route) return;
	await enqueueNotify(deps, routeRefOf(route), { type: "card", card });
}

/** 广播卡片到所有会话。 */
export async function notifyOwnerCard(
	deps: NotificationDeps,
	card: unknown,
): Promise<void> {
	for (const route of Object.values(deps.router.routesSnapshot())) {
		await enqueueNotify(deps, routeRefOf(route), { type: "card", card });
	}
}
