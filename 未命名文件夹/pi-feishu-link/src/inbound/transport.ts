// Feishu transport (spec §6.1): wraps the lark SDK (Client + WSClient +
// EventDispatcher) behind a structural interface so it is testable with a
// fake SDK. Owns error classification (retryable vs fatal), inbound
// normalization, and REST send primitives with timeouts.

import { RetryableError, FatalDeliveryError } from "../outbound/outbox.js";
import type { FeishuConfig, FeishuInboundMessage } from "../common/types.js";
import type { SupervisorTransport } from "./connection-supervisor.js";

// ---- structural SDK interfaces (the real @larksuiteoapi/node-sdk matches) ----

export interface LarkHttpError {
	status?: number;
	code?: number;
	msg?: string;
	message?: string;
}

export interface LarkSdkClient {
	request(opts: {
		url: string;
		method: string;
		params?: Record<string, unknown>;
		data?: unknown;
		headers?: Record<string, string>;
	}): Promise<unknown>;
	im: {
		message: {
			reply(opts: {
				path: { message_id: string };
				data: { msg_type: string; content: string };
			}): Promise<unknown>;
			create(opts: {
				params: { receive_id_type: string };
				data: { receive_id: string; msg_type: string; content: string };
			}): Promise<unknown>;
			patch(opts: {
				path: { message_id: string };
				data: { content: string };
			}): Promise<unknown>;
			get(opts: { path: { message_id: string } }): Promise<unknown>;
		};
		v1: {
			image: {
				create(opts: {
					data: { image_type: string; image: unknown };
				}): Promise<{ image_key?: string } | { data?: { image_key?: string } }>;
			};
			file: {
				create(opts: {
					data: { file_type: string; file_name: string; file: unknown };
				}): Promise<{ file_key?: string } | { data?: { file_key?: string } }>;
			};
			message: {
				patch(opts: {
					path: { message_id: string };
					data: { content: string };
				}): Promise<unknown>;
				list(opts: {
					params: {
						container_id_type: string;
						container_id: string;
						start_time?: string;
						end_time?: string;
						page_size?: number;
					};
				}): Promise<{ data?: { items?: Array<Record<string, unknown>> } }>;
			};
			messageResource: {
				get(opts: {
					params: { type: string };
					path: { message_id: string; file_key: string };
				}): Promise<{
					getReadableStream?(): AsyncIterable<Buffer | string>;
					headers?: Record<string, string>;
				}>;
			};
		};
	};
}

export interface LarkSdkDispatcher {
	register(
		handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>,
	): LarkSdkDispatcher;
}

export interface LarkSdkWsClient {
	start(opts: { eventDispatcher: LarkSdkDispatcher }): void;
	stop(): Promise<void>;
}

export interface LarkSdkLike {
	Domain: { Feishu: string; Lark: string };
	// The real SDK exports CLASS constructors (require `new`); the fake SDK in
	// tests must therefore also be constructable (`new FakeClient()`).
	Client: new (opts: {
		appId: string;
		appSecret: string;
		appType: number; // AppType enum: 0 = SelfBuild, 1 = ISV
		domain: string;
		loggerLevel?: number;
	}) => LarkSdkClient;
	WSClient: new (opts: {
		appId: string;
		appSecret: string;
		// 实机验证（2026-08-07）：domain 运行时默认 Domain.Feishu，显式传入
		// 会破坏事件投递——类型设为可选，与 SDK 默认行为一致。
		domain?: string;
		appType?: number; // AppType enum: 0 = SelfBuild, 1 = ISV
		loggerLevel?: number;
		// 连接健康（2026-08-07 加固）：autoReconnect:false + onReady/onError
		// 让 supervisor 感知 WS 真实状态，用受控退避重连而非 SDK 内部无限重试。
		autoReconnect?: boolean;
		onReady?: () => void;
		onError?: (err: unknown) => void;
	}) => LarkSdkWsClient;
	EventDispatcher: new (opts: { loggerLevel?: number }) => LarkSdkDispatcher;
}

// ---- error classification (spec §6.1) ----

const SEND_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Lark business-error codes that are transient (server-side / rate limit-ish)
 * and safe to retry; other non-zero business codes are deterministic request
 * errors → terminal (M3: HTTP 200 + code≠0 would otherwise retry forever).
 */
const RETRYABLE_BUSINESS_CODES = new Set<number>([
	99991663, // internal service error
	99991600, // internal service error
	99991602, // internal service error
	10002, // gateway/rate limit
	10003, // gateway/rate limit
]);

export function classifyError(err: unknown): {
	kind: "retryable" | "fatal";
	message: string;
} {
	const status = (err as LarkHttpError)?.status;
	const code = (err as LarkHttpError)?.code;
	const msg =
		(err as LarkHttpError)?.message ??
		(err as LarkHttpError)?.msg ??
		(err instanceof Error ? err.message : String(err));
	if (status !== undefined) {
		if (status === 429 || status >= 500)
			return { kind: "retryable", message: msg };
		if (status >= 400 && status < 500) return { kind: "fatal", message: msg };
	}
	// Business-error shape (HTTP 200 + code ≠ 0): deterministic → fatal,
	// except the known-transient set.
	if (typeof code === "number" && code !== 0) {
		return RETRYABLE_BUSINESS_CODES.has(code)
			? { kind: "retryable", message: msg }
			: { kind: "fatal", message: msg };
	}
	// Network errors / timeouts / unknown → retryable (safe default).
	return { kind: "retryable", message: msg };
}

/** Race a promise against a timeout; throws RetryableError on expiry (M2). */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new RetryableError(`timeout:${label} (${ms}ms)`)),
			ms,
		);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export function wrapSendError(
	err: unknown,
): RetryableError | FatalDeliveryError {
	const { kind, message } = classifyError(err);
	return kind === "fatal"
		? new FatalDeliveryError(message)
		: new RetryableError(message);
}

// ---- inbound normalization (pure, tested) ----

export interface RawInbound {
	message_id?: string;
	chat_id?: string;
	chat_type?: "p2p" | "group";
	message_type?: string;
	content?: string;
	root_id?: string;
	parent_id?: string;
	thread_id?: string;
	mentions?: Array<{ id?: { open_id?: string; union_id?: string } }>;
	sender?: { sender_type?: string; sender_id?: { open_id?: string } };
	create_time?: string;
}

export function normalizeInbound(
	raw: unknown,
): FeishuInboundMessage | undefined {
	const root = (raw ?? {}) as Record<string, unknown>;
	// SDK dispatcher 可能传 { event: {...} } 包装；剥掉取事件体。
	const body = (root.event ?? root) as Record<string, unknown>;
	// v2.0：消息字段在 event.message 子对象、sender 在 event 顶层；
	// v1.0：字段全在顶层。message_id 在嵌套里时旧实现直接丢弃（2026-08-08 修复）。
	const msg = (body.message ?? body ?? {}) as RawInbound;
	if (!msg.message_id) return undefined;
	const chatType = msg.chat_type === "group" ? "group" : "p2p";
	const sender = (body.sender ?? msg.sender ?? {}) as
		| { sender_type?: string; sender_id?: { open_id?: string } }
		| undefined;
	return {
		messageId: msg.message_id,
		chatId: msg.chat_id ?? "",
		chatType,
		chatMode: chatType === "p2p" ? "p2p" : "group",
		senderOpenId: sender?.sender_id?.open_id ?? "unknown",
		senderType: sender?.sender_type ?? "user",
		msgType: msg.message_type ?? "text",
		content: msg.content ?? "",
		rootId: msg.root_id,
		parentId: msg.parent_id,
		threadId: msg.thread_id,
		mentions: msg.mentions,
		timestamp: Number(msg.create_time ?? Date.now()),
	};
}

// ---- transport ----

export interface CardAction {
	messageId: string;
	chatId?: string;
	operatorOpenId: string;
	token?: string;
	value?: Record<string, unknown>;
}

export interface FeishuTransportDeps {
	sdk: LarkSdkLike;
	config: FeishuConfig;
	onMessage: (msg: FeishuInboundMessage) => Promise<void>;
	onCardAction: (action: CardAction) => Promise<unknown>;
	logger?: {
		debug(event: string, data?: Record<string, unknown>): void;
		error(event: string, data?: Record<string, unknown>): void;
	};
}

export class FeishuTransport implements SupervisorTransport {
	private readonly deps: FeishuTransportDeps;
	private client: LarkSdkClient | undefined;
	private wsClient: LarkSdkWsClient | undefined;
	private running = false;
	private wsReady = false;
	private botOpenId: string | undefined;
	private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();
	/** Cached tenant_access_token (SDK's bare client.request() does NOT attach it). */
	private tenantToken: { value: string; expiresAt: number } | undefined;

	constructor(deps: FeishuTransportDeps) {
		this.deps = deps;
	}

	/**
	 * Get a cached tenant_access_token. The lark SDK's low-level
	 * `client.request()` does NOT attach auth automatically (returns
	 * 99991661 “Missing access token”), so every raw REST call must carry
	 * `Authorization: Bearer <token>` — this is what was keeping the bridge
	 * stuck in `degraded` (probeBotOpenId failed → WS never started).
	 */
	private async ensureTenantToken(): Promise<string> {
		if (this.tenantToken && Date.now() < this.tenantToken.expiresAt) {
			return this.tenantToken.value;
		}
		if (!this.client) throw new Error("client not initialized");
		const res = (await this.client.request({
			url: "/open-apis/auth/v3/tenant_access_token/internal",
			method: "POST",
			data: {
				app_id: this.deps.config.appId,
				app_secret: this.deps.config.appSecret,
			},
		})) as { code?: number; tenant_access_token?: string; expire?: number };
		if (res.code !== 0 || !res.tenant_access_token) {
			throw new Error(
				`tenant_access_token failed (code=${res.code ?? "?"}): ${JSON.stringify(res).slice(0, 200)}`,
			);
		}
		// Token lives 2h; cache for 100 minutes to stay safely under expiry.
		const ttl = (res.expire ?? 7200) - 200;
		this.tenantToken = {
			value: res.tenant_access_token,
			expiresAt: Date.now() + Math.max(60, ttl) * 1000,
		};
		return res.tenant_access_token;
	}

	private async authedRequest(opts: {
		url: string;
		method: string;
		params?: Record<string, unknown>;
		data?: unknown;
	}): Promise<unknown> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const token = await this.ensureTenantToken();
		return this.client.request({
			...opts,
			headers: { Authorization: `Bearer ${token}` },
		});
	}

	async start(): Promise<void> {
		if (this.running) return;
		const { sdk, config } = this.deps;
		const domain =
			config.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
		this.client = new sdk.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			appType: 0, // AppType.SelfBuild
			domain,
		});
		await this.probeBotOpenId();
		const dispatcher = new sdk.EventDispatcher({})
			.register({
				"im.message.receive_v1": async (data: unknown) =>
					this.handleRawMessage(data),
			})
			.register({
				"card.action.trigger": async (data: unknown) =>
					this.handleCardAction(data),
			})
			.register({
				// 2026-08-08：桥自己加表情会触发 reaction.created 推送，
				// 无需处理——注册空 handler 消除 SDK "no handler" warn。
				"im.message.reaction.created_v1": async () => undefined,
			});
		this.wsClient = new sdk.WSClient({
			appId: config.appId,
			appSecret: config.appSecret,
			// 实机验证（2026-08-07）：
			// 1) WSClient 不需要 appType/domain（REST Client 才需要）；
			// 2) autoReconnect:false —— SDK 内部无限重试会在连接被拒（如
			//    exceed_conn_limit 配额封锁）时疯狂打点，把配额锁得更久。
			//    改为由 supervisor 用受控退避重连（connect() 检查 isConnected）。
			autoReconnect: false,
			onReady: () => {
				this.wsReady = true;
				this.deps.logger?.debug("feishu.transport.ws_ready");
			},
			onError: (err: unknown) => {
				this.wsReady = false;
				this.deps.logger?.error("feishu.transport.ws_error", {
					error: err instanceof Error ? err.message : String(err),
				});
			},
		});
		this.running = true;
		try {
			this.wsClient.start({ eventDispatcher: dispatcher });
		} catch (err) {
			this.running = false;
			throw err;
		}
	}

	/** WS 是否已成功握手（supervisor 据此决定是否重试，而不是假装成功）。 */
	isConnected(): boolean {
		return this.wsReady;
	}

	async stop(): Promise<void> {
		this.running = false;
		try {
			await this.wsClient?.stop();
		} catch {
			/* ignore */
		}
		this.wsClient = undefined;
	}

	isRunning(): boolean {
		return this.running;
	}

	getBotOpenId(): string | undefined {
		return this.botOpenId;
	}

	async probe(): Promise<{ ok: boolean; latencyMs: number }> {
		const started = Date.now();
		try {
			if (!this.client) return { ok: false, latencyMs: 0 };
			await this.authedRequest({
				url: "/open-apis/bot/v3/info",
				method: "GET",
			});
			return { ok: true, latencyMs: Date.now() - started };
		} catch {
			return { ok: false, latencyMs: Date.now() - started };
		}
	}

	private async probeBotOpenId(): Promise<void> {
		// 2026-08-08 修复：瞬态网络错误（ECONNRESET）不应导致 startBridge 抛错
		// → daemon 崩溃（用户"发送消息没响应"——daemon 反复死于 TLS 重置）。
		// 重试 3 次退避；最终失败降级（botOpenId 留空，isMentioned 视为全提及）。
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const res = (await this.authedRequest({
					url: "/open-apis/bot/v3/info",
					method: "GET",
				})) as Record<string, unknown>;
				const bot = (res?.bot ?? res?.data ?? {}) as Record<string, unknown>;
				const openId = (bot.open_id ??
					(res?.data as Record<string, unknown> | undefined)?.open_id) as
					| string
					| undefined;
				if (openId) {
					this.botOpenId = openId;
					return;
				}
			} catch (err) {
				if (attempt < 3) {
					await new Promise((r) => setTimeout(r, attempt * 1000));
					continue;
				}
				this.deps.logger?.error("feishu.bot_probe_failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		// 降级：botOpenId 留空，不阻止启动（isMentioned 对 undefined 视为全提及）。
		this.deps.logger?.error("feishu.bot_probe_failed", {
			error: "bot/v3/info missing open_id",
		});
	}

	private async handleRawMessage(data: unknown): Promise<void> {
		const event = ((data as { event?: unknown })?.event ?? data) as RawInbound;
		const normalized = normalizeInbound(event);
		if (!normalized) return;
		const chatMode = await this.getChatMode(normalized);
		normalized.chatMode = chatMode;
		this.deps.logger?.debug("feishu.msg.received", {
			messageId: normalized.messageId,
			chatType: normalized.chatType,
			msgType: normalized.msgType,
		});
		void this.deps.onMessage(normalized).catch((err) => {
			this.deps.logger?.error("feishu.msg.dispatch_error", {
				error: String(err),
			});
		});
	}

	private async handleCardAction(data: unknown): Promise<unknown> {
		const d = data as Record<string, unknown>;
		const context = (d?.context ?? d) as Record<string, unknown>;
		const messageId = (context.open_message_id ??
			context.message_id ??
			d.open_message_id) as string | undefined;
		const chatId = (context.open_chat_id ??
			context.chat_id ??
			d.open_chat_id) as string | undefined;
		const operator = (d?.operator ?? {}) as Record<string, unknown>;
		const operatorOpenId = operator.open_id as string | undefined;
		if (!messageId || !operatorOpenId) return undefined;
		const action = (d?.action ?? {}) as Record<string, unknown>;
		const result = await this.deps.onCardAction({
			messageId,
			chatId,
			operatorOpenId,
			token: typeof d.token === "string" ? d.token : undefined,
			value:
				typeof action.value === "object" && action.value !== null
					? (action.value as Record<string, unknown>)
					: undefined,
		});
		if (result) return { card: { type: "raw", data: result } };
		return result;
	}

	async getChatMode(
		normalized: FeishuInboundMessage,
	): Promise<"p2p" | "group" | "topic"> {
		if (normalized.chatType === "p2p") return "p2p";
		const cached = this.chatModeCache.get(normalized.chatId);
		if (cached) return cached;
		if (!this.client) return normalized.chatType;
		try {
			const res = (await this.authedRequest({
				url: `/open-apis/im/v1/chats/${normalized.chatId}`,
				method: "GET",
			})) as { data?: { chat_mode?: string } };
			const mode = res?.data?.chat_mode === "topic" ? "topic" : "group";
			this.chatModeCache.set(normalized.chatId, mode);
			return mode;
		} catch {
			return normalized.chatType;
		}
	}

	async addReaction(messageId: string, emojiType: string): Promise<void> {
		if (!this.client) return;
		try {
			await this.authedRequest({
				url: `/open-apis/im/v1/messages/${messageId}/reactions`,
				method: "POST",
				data: { reaction_type: { emoji_type: emojiType } },
			});
		} catch (err) {
			// 2026-08-08：打日志便于排查表情回执缺失（此前静默吞错）。
			// 带响应体 code/msg（如 231001 emoji 类型无效——曾把 FIRE 写成
			// 大写导致抽到该表情时 400）。
			const e = err as {
				response?: { data?: { code?: number; msg?: string } };
			};
			this.deps.logger?.error("feishu.reaction.failed", {
				messageId,
				emojiType,
				code: e.response?.data?.code,
				msg: e.response?.data?.msg,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ---- outbound media (M7) ----

	/** Upload an image and return its image_key. */
	async uploadImage(base64: string): Promise<string> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = await withTimeout(
			this.client.im.v1.image.create({
				data: { image_type: "message", image: Buffer.from(base64, "base64") },
			}),
			UPLOAD_TIMEOUT_MS,
			"uploadImage",
		);
		const key =
			(res as { image_key?: string })?.image_key ??
			(res as { data?: { image_key?: string } })?.data?.image_key;
		if (!key) throw new FatalDeliveryError("upload image failed: no image_key");
		return key;
	}

	/** Upload a file and return its file_key. */
	async uploadFile(fileName: string, base64: string): Promise<string> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = await withTimeout(
			this.client.im.v1.file.create({
				data: {
					file_type: "stream",
					file_name: fileName,
					file: Buffer.from(base64, "base64"),
				},
			}),
			UPLOAD_TIMEOUT_MS,
			"uploadFile",
		);
		const key =
			(res as { file_key?: string })?.file_key ??
			(res as { data?: { file_key?: string } })?.data?.file_key;
		if (!key) throw new FatalDeliveryError("upload file failed: no file_key");
		return key;
	}

	/** Send an uploaded image by image_key. */
	async sendImage(
		chatId: string,
		imageKey: string,
	): Promise<string | undefined> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = (await withTimeout(
			this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "image",
					content: JSON.stringify({ image_key: imageKey }),
				},
			}),
			SEND_TIMEOUT_MS,
			"sendImage",
		)) as { data?: { message_id?: string } };
		return res?.data?.message_id;
	}

	/** Send an uploaded file by file_key. */
	async sendFile(chatId: string, fileKey: string): Promise<string | undefined> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = (await withTimeout(
			this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "file",
					content: JSON.stringify({ file_key: fileKey }),
				},
			}),
			SEND_TIMEOUT_MS,
			"sendFile",
		)) as { data?: { message_id?: string } };
		return res?.data?.message_id;
	}

	async replyText(
		messageId: string,
		text: string,
	): Promise<string | undefined> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = (await withTimeout(
			this.client.im.message.reply({
				path: { message_id: messageId },
				data: { msg_type: "text", content: JSON.stringify({ text }) },
			}),
			SEND_TIMEOUT_MS,
			"replyText",
		)) as { data?: { message_id?: string } };
		return res?.data?.message_id;
	}

	async sendText(chatId: string, text: string): Promise<string | undefined> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = (await withTimeout(
			this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text }),
				},
			}),
			SEND_TIMEOUT_MS,
			"sendText",
		)) as { data?: { message_id?: string } };
		return res?.data?.message_id;
	}

	async replyCard(
		messageId: string,
		card: unknown,
	): Promise<string | undefined> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = (await withTimeout(
			this.client.im.message.reply({
				path: { message_id: messageId },
				data: { msg_type: "interactive", content: JSON.stringify(card) },
			}),
			SEND_TIMEOUT_MS,
			"replyCard",
		)) as { data?: { message_id?: string } };
		return res?.data?.message_id;
	}

	async sendCard(chatId: string, card: unknown): Promise<string | undefined> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = (await withTimeout(
			this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify(card),
				},
			}),
			SEND_TIMEOUT_MS,
			"sendCard",
		)) as { data?: { message_id?: string } };
		return res?.data?.message_id;
	}

	async updateCard(messageId: string, card: unknown): Promise<void> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		await withTimeout(
			this.client.im.v1.message.patch({
				path: { message_id: messageId },
				data: { content: JSON.stringify(card) },
			}),
			SEND_TIMEOUT_MS,
			"updateCard",
		);
	}

	/** List recent messages in a chat (used for missed-message compensation). */
	async listMessages(
		chatId: string,
		opts: { startTimeMs?: number; endTimeMs?: number; pageSize?: number } = {},
	): Promise<Array<Record<string, unknown>>> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const res = await this.client.im.v1.message.list({
			params: {
				container_id_type: "chat",
				container_id: chatId,
				...(opts.startTimeMs ? { start_time: String(opts.startTimeMs) } : {}),
				...(opts.endTimeMs ? { end_time: String(opts.endTimeMs) } : {}),
				...(opts.pageSize ? { page_size: opts.pageSize } : {}),
			},
		});
		return res?.data?.items ?? [];
	}

	async getMessage(
		messageId: string,
	): Promise<{ msgType: string; content: string } | undefined> {
		if (!this.client) return undefined;
		try {
			const res = (await this.client.im.message.get({
				path: { message_id: messageId },
			})) as {
				data?: {
					items?: Array<{
						message_type?: string;
						content?: string;
						body?: { message_type?: string; content?: string };
					}>;
				};
			};
			const item = res?.data?.items?.[0];
			if (!item) return undefined;
			const body = item.body ?? item;
			return {
				msgType: body.message_type ?? "unknown",
				content: body.content ?? "",
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * Download an attachment with a hard byte cap enforced DURING the stream
	 * (I6: limits must not only be checked after a full unbounded download).
	 */
	async downloadResource(
		messageId: string,
		fileKey: string,
		type: "image" | "file",
		maxBytes?: number,
	): Promise<{ bytes: Buffer; mimeType?: string }> {
		if (!this.client) throw new FatalDeliveryError("transport not started");
		const result = await withTimeout(
			this.client.im.v1.messageResource.get({
				params: { type },
				path: { message_id: messageId, file_key: fileKey },
			}),
			DOWNLOAD_TIMEOUT_MS,
			"downloadResource",
		);
		const readable = result.getReadableStream
			? result.getReadableStream()
			: result;
		const chunks: Buffer[] = [];
		let total = 0;
		const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
		for await (const chunk of readable as AsyncIterable<Buffer | string>) {
			if (Date.now() > deadline) {
				throw new FatalDeliveryError("downloadResource timed out");
			}
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buf.length;
			if (maxBytes !== undefined && total > maxBytes) {
				throw new FatalDeliveryError(
					`attachment exceeds ${maxBytes} bytes (${total} received)`,
				);
			}
			chunks.push(buf);
		}
		const raw =
			result.headers?.["content-type"] ?? result.headers?.["Content-Type"];
		const mimeType =
			typeof raw === "string" ? raw.split(";")[0]?.trim() : undefined;
		return { bytes: Buffer.concat(chunks), mimeType };
	}
}

/** Build a real transport from the lark SDK (used by index.ts). */
export async function createFeishuTransport(
	config: FeishuConfig,
	deps: Omit<FeishuTransportDeps, "sdk" | "config">,
): Promise<FeishuTransport> {
	const lark = (await import(
		"@larksuiteoapi/node-sdk"
	)) as unknown as LarkSdkLike;
	return new FeishuTransport({ sdk: lark, config, ...deps });
}
