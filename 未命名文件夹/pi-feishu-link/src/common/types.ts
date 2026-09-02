// Domain types for the pi-feishu-link extension.

export type Domain = "feishu" | "lark";
export type GroupPolicy = "open" | "mention";

export type ForwardMode = "off" | "summary" | "detail" | "card" | "text";
export type AiReplyMode = "card" | "text";

export interface ForwardConfig {
	aiReply: { mode: AiReplyMode };
	streaming: { enabled: boolean; throttleMs: number };
	toolCalls: { mode: "off" | "summary" | "detail" };
	reasoning: { mode: "off" | "card" };
	progress: { enabled: boolean };
	reactions: {
		enabled: boolean;
		/** 入站随机表情池（排除 DONE，可覆盖） */
		emojis: string[];
		/** 任务完成时对触发消息打的表情（默认 DONE） */
		doneEmoji: string;
	};
}

export interface ConnectionConfig {
	probeIntervalMs: number;
	silenceSuspectMs: number;
	reconnectBackoffMaxMs: number;
	downReportEnabled: boolean;
}

export interface TurnsConfig {
	turnTimeoutMs: number;
	ackAfterMs: number;
	queueWarnMs: number;
}

export interface SessionsConfig {
	maxResident: number;
	idleDisposeMs: number;
}

export interface OutboxConfig {
	dir: string;
	maxAttemptsBeforeAlert: number;
	sentRetentionMs: number;
	maxPendingEnvelopes: number;
	maxEnvelopeBytes: number;
	maxOutboxDirBytes: number;
	compactIntervalMs: number;
}

export interface MediaConfig {
	maxAttachments: number;
	maxTotalBytes: number;
}

export interface StorageConfig {
	sessionRetentionDays: number;
}

export type PermissionPolicy = "relaxed" | "strict";

export interface PermissionsConfig {
	policy: PermissionPolicy;
	/** Groups ALWAYS require approval for non-safe tools (spec §6.15); p2p uses `policy`. */
	autoApprove: string[];
	approvalTimeoutMs: number;
	sessionMemory: boolean;
}

export interface NotificationsConfig {
	mergeWindowMs: number;
}

export interface FeishuConfig {
	schemaVersion: 1;
	appId: string;
	appSecret: string;
	domain: Domain;
	autoStart: boolean;
	groupPolicy: GroupPolicy;
	groupKeywords: string[];
	groupAlsoOnReply: boolean;
	allowUsers: string[];
	allowChats: string[];
	admins: string[];
	/** First p2p sender is auto-recorded as the bridge owner (admin by default). */
	ownerOpenId?: string;
	forward: ForwardConfig;
	connection: ConnectionConfig;
	turns: TurnsConfig;
	sessions: SessionsConfig;
	outbox: OutboxConfig;
	media: MediaConfig;
	storage: StorageConfig;
	permissions: PermissionsConfig;
	notifications: NotificationsConfig;
	logging: { level: "debug" | "info" | "warn" | "error" };
}

/** Normalized inbound message from Feishu. */
export interface FeishuInboundMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group";
	chatMode: "p2p" | "group" | "topic";
	senderOpenId: string;
	senderType: string;
	msgType: string;
	content: string;
	rootId?: string;
	parentId?: string;
	threadId?: string;
	mentions?: Array<{ id?: { open_id?: string; union_id?: string } }>;
	timestamp: number;
}

/** Conversation key: p2p → userOpenId, group → chatId (topic-aware). */
export type ConversationKey = string;

/** Resolved route for outbound delivery. */
export interface Route {
	sessionKey: ConversationKey;
	sessionId?: string;
	chatId: string;
	chatType: "p2p" | "group";
	threadMessageId?: string;
	lastMessageId?: string;
	updatedAt: number;
}

export type EnvelopeKind =
	| "final"
	| "tool"
	| "notify"
	| "scheduled"
	| "command-reply"
	| "media"
	| "assistant-output";

export type EnvelopeStatus = "pending" | "sending" | "sent" | "failed";

export type Payload =
	| { type: "text"; text: string; cardId?: string }
	| { type: "card"; card: unknown; cardId?: string }
	| { type: "markdown"; markdown: string }
	| { type: "media"; fileType: number; fileData: string; fileName?: string };

export interface OutboundEnvelope {
	id: string;
	dedupeKey: string;
	laneKey: string;
	route: RouteRef;
	kind: EnvelopeKind;
	payload: Payload;
	status: EnvelopeStatus;
	attempts: number;
	nextRetryAt: number;
	createdAt: number;
	sentAt?: number;
	lastError?: string;
}

export interface RouteRef {
	conversationKey: string;
	chatId: string;
	chatType: "p2p" | "group";
	threadMessageId?: string;
	lastMessageId?: string;
}

export type ConnState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "degraded"
	| "restarting";

export interface StatusSnapshot {
	connState: ConnState;
	connectedAt?: number;
	lastEventAt?: number;
	lastProbeAt?: number;
	lastProbeOk?: boolean;
	lastProbeLatencyMs?: number;
	reconnectCount: number;
	lastReconnectAt?: number;
	lastReconnectDurationMs?: number;
	inboundCount: number;
	outboundCount: number;
	outboxPending: number;
	outboxFailed: number;
	residentSessions: number;
	maxResident: number;
	schedulerDetected: boolean;
	boundJobs: number;
	startedAt: number;
}

export type Severity = "info" | "warn" | "critical";

export interface NotificationEvent {
	id: string;
	severity: Severity;
	type: string;
	message: string;
	data?: Record<string, unknown>;
	createdAt: number;
}
