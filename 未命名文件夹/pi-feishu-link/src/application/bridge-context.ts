// DDD 应用服务层（spec 2026-08-08-1700）：BridgeContext 装配对象——所有编排
// 服务的依赖注入点（依赖倒置：应用层不直接 new 域对象，由 index.ts 装配）。

import type { FeishuConfig } from "../common/types.js";
import type { ConversationManager } from "../sessions/conversation-manager.js";
import type { PiSessionBackend } from "../sessions/pi-session-backend.js";
import type { FeishuTransport } from "../inbound/transport.js";
import type { Outbox } from "../outbound/outbox.js";
import type { OutboundRouter } from "../outbound/outbound-router.js";
import type { LiveChannel } from "../outbound/live-channel.js";
import type { EventForwarder } from "../outbound/event-forwarder.js";
import type { StatusStore } from "../common/status.js";
import type { Logger } from "../common/logger.js";
import type { BridgeRuntime } from "../sessions/bridge-runtime.js";
import type { PermissionBridge } from "../sessions/permission-bridge.js";
import type { TurnSupervisor } from "../sessions/turn-supervisor.js";
import type { GatewayOwner } from "../host/gateway-lock.js";
import type { FeishuInboundMessage, RouteRef } from "../common/types.js";

/** 流式卡片状态（M4 TTL）。 */
export interface StreamCardState {
	messageId: string;
	text: string;
	touchedAt: number;
}

/** 流式卡片回复目标（spec §3.1 B1：真实 messageId/chatId）。 */
export interface StreamTarget {
	messageId?: string;
	chatId: string;
}

/** 应用服务层的依赖装配对象（由 index.ts 构建并注入）。 */
export interface BridgeContext {
	// ---- 域服务 ----
	conversations?: ConversationManager;
	transport?: FeishuTransport;
	outbox?: Outbox;
	router: OutboundRouter;
	statusStore: StatusStore;
	liveChannel?: LiveChannel;
	eventForwarder?: EventForwarder;
	bridgeRuntime?: BridgeRuntime;
	permissionBridge?: PermissionBridge;
	turnSupervisor?: TurnSupervisor;
	piBackend?: PiSessionBackend;
	// ---- 基础设施 ----
	logger: Logger;
	cfg: () => FeishuConfig | undefined;
	// ---- 可变状态 ----
	botOpenId?: string;
	started: boolean;
	streamCards: Map<string, StreamCardState>;
	streamTargets: Map<string, StreamTarget>;
	gatewayLock?: {
		owner: GatewayOwner;
		release(): Promise<void>;
		update(status: GatewayOwner["status"]): void;
	};
	stopBridge: () => Promise<void>;
	// ---- 工具（编排共享） ----
	notifyOwner(text: string): Promise<void>;
	notifyConversation(key: string, text: string): Promise<void>;
	replyTo(
		msg: FeishuInboundMessage,
		textOrCard: string | unknown,
	): Promise<void>;
	conversationKeyFor(msg: FeishuInboundMessage): string;
	markDone(msg: FeishuInboundMessage): void;
	routeRefFor(msg: FeishuInboundMessage): RouteRef;
}
