// DDD 应用层（spec 2026-08-08-1700 Step 4）：消息编排——handleInbound 从
// index.ts 迁出（依赖注入 MessageHandlerDeps）。handleConversationMessage
// 在后续步骤迁入（当前通过 deps 回调注入）。

import type { DedupeStore } from "../common/dedupe-store.js";
import type { StatusStore } from "../common/status.js";
import type { FeishuConfig, FeishuInboundMessage } from "../common/types.js";
import type { ConversationManager } from "../sessions/conversation-manager.js";
import type { PiSessionBackend } from "../sessions/pi-session-backend.js";
import type { FeishuTransport } from "../inbound/transport.js";
import type { Outbox } from "../outbound/outbox.js";
import type { OutboundRouter } from "../outbound/outbound-router.js";
import {
	extractPlainTextForTrigger,
	parseGroupKeywords,
	shouldAcceptGroupMessage,
} from "../inbound/group-trigger.js";
import { pickRandomReaction } from "../common/reactions.js";
import {
	getPendingSelect,
	tryConsumeSelect,
} from "../commands/pi-command-adapter.js";
import {
	isVoiceMessage,
	processAttachments,
} from "../inbound/attachment-pipeline.js";
import { parseCommand } from "../commands/command-controller.js";
import type { LiveChannel } from "../outbound/live-channel.js";
import type { EventForwarder } from "../outbound/event-forwarder.js";
import type { BridgeRuntime } from "../sessions/bridge-runtime.js";
import { DEFAULT_CONFIG } from "../common/config.js";

export interface MessageHandlerDeps {
	supervisor?: { recordEvent(): void };
	dedupe: DedupeStore;
	statusStore: StatusStore;
	cfg(): FeishuConfig | undefined;
	saveConfig(cfg: FeishuConfig): void;
	botOpenId?: string;
	conversations?: ConversationManager;
	transport?: FeishuTransport;
	outbox?: Outbox;
	router: OutboundRouter;
	piBackend?: PiSessionBackend;
	liveChannel?: LiveChannel;
	eventForwarder?: EventForwarder;
	bridgeRuntime?: BridgeRuntime;
	streamTargets: Map<string, { messageId?: string; chatId: string }>;
	logger: { info(event: string, data?: Record<string, unknown>): void };
	replyTo(
		msg: FeishuInboundMessage,
		textOrCard: string | unknown,
	): Promise<void>;
	conversationKeyFor(msg: FeishuInboundMessage): string;
	handleCommand(
		msg: FeishuInboundMessage,
		cmd: { name: string; rawArgs: string; args: string[] },
		rawText: string,
	): Promise<void>;
	buildWelcomeCard(name: string): unknown;
}

/** I9: auto-record the first p2p sender as owner (admin by default). */
export function recordOwnerIfUnset(
	deps: Pick<MessageHandlerDeps, "cfg" | "saveConfig" | "logger">,
	userOpenId: string,
	chatType: string,
): void {
	if (chatType !== "p2p") return;
	const cfg = deps.cfg();
	if (!cfg || cfg.ownerOpenId) return;
	if (cfg.allowUsers.length > 0) return;
	cfg.ownerOpenId = userOpenId;
	try {
		deps.saveConfig(cfg);
		deps.logger.info("feishu.owner.recorded", {});
	} catch {
		/* best-effort */
	}
}

function isMentioned(
	deps: Pick<MessageHandlerDeps, "botOpenId">,
	msg: FeishuInboundMessage,
): boolean {
	if (!deps.botOpenId) return true;
	return Boolean(
		msg.mentions?.some(
			(m) =>
				m?.id?.open_id === deps.botOpenId || m?.id?.union_id === deps.botOpenId,
		),
	);
}

function isReplyToBot(
	deps: Pick<MessageHandlerDeps, "router" | "conversationKeyFor">,
	msg: FeishuInboundMessage,
): boolean {
	const parent = msg.parentId;
	if (!parent) return false;
	// best-effort: the transport tracks bot outbound ids; approximate by
	// checking the route's last bot message.
	return (
		deps.router.getRoute(deps.conversationKeyFor(msg))?.lastMessageId === parent
	);
}

/**
 * 入站消息编排（spec §6.2 / 2026-08-08 三级分流）：
 * 去重 → 白名单 → owner 记录 → 欢迎卡 → 群策略 → 随机表情 → 交互选择 →
 * 命令路由 → 多媒体 → 对话。C2：补偿注入走 skipDedupe 旁路。
 */
export async function handleInbound(
	deps: MessageHandlerDeps,
	msg: FeishuInboundMessage,
	opts: { skipDedupe?: boolean } = {},
): Promise<void> {
	deps.supervisor?.recordEvent();
	// C2: compensation re-injects already-admitted messages — it pre-checks
	// the dedupe store itself, so it must bypass this re-check.
	if (!opts.skipDedupe && !deps.dedupe.admit(msg.messageId)) return;
	if (msg.senderType === "bot") return;
	deps.statusStore.recordInbound();
	deps.logger.info("feishu.msg.received", {
		messageId: msg.messageId,
		chatType: msg.chatType,
		text: (msg.content ?? "").slice(0, 60),
	});
	const cfg = deps.cfg();
	if (!cfg) {
		deps.logger.info("feishu.msg.drop_no_config");
		return;
	}
	if (cfg.allowUsers.length > 0 && !cfg.allowUsers.includes(msg.senderOpenId)) {
		deps.logger.info("feishu.msg.drop_allowusers", {
			senderOpenId: msg.senderOpenId,
		});
		return;
	}
	if (cfg.allowChats.length > 0 && !cfg.allowChats.includes(msg.chatId)) {
		deps.logger.info("feishu.msg.drop_allowchats", {
			chatId: msg.chatId,
		});
		return;
	}
	// I9: auto-record the first p2p sender as owner (admin by default).
	recordOwnerIfUnset(deps, msg.senderOpenId, msg.chatType);
	const key = deps.conversationKeyFor(msg);
	// M2/§9.1: welcome card on the first message of a brand-new chat.
	const isNewChat = !deps.router.getRoute(key);
	if (isNewChat && msg.chatType === "p2p") {
		void deps.outbox
			?.enqueue({
				dedupeKey: `welcome:${key}`,
				laneKey: key,
				route: {
					conversationKey: key,
					chatId: msg.chatId,
					chatType: msg.chatType,
					threadMessageId: msg.messageId,
				},
				kind: "notify",
				payload: { type: "card", card: deps.buildWelcomeCard("飞书桥") },
			})
			.catch(() => undefined);
	}

	if (msg.chatType === "group") {
		const text = extractPlainTextForTrigger(msg.msgType, msg.content);
		const decision = shouldAcceptGroupMessage({
			chatType: "group",
			groupPolicy: cfg.groupPolicy,
			mentioned: isMentioned(deps, msg),
			text,
			keywords: parseGroupKeywords(cfg.groupKeywords),
			alsoOnReply: cfg.groupAlsoOnReply,
			replyToBot: isReplyToBot(deps, msg),
		});
		if (!decision.accept) {
			deps.logger.info("feishu.msg.drop_grouppolicy", {
				key: deps.conversationKeyFor(msg),
			});
			return;
		}
	}

	if (cfg.forward.reactions.enabled) {
		// 入站随机表情回执：随机池排除 DONE。
		void deps.transport?.addReaction(
			msg.messageId,
			pickRandomReaction(cfg.forward.reactions.emojis),
		);
	}

	deps.router.bindConversation(
		deps.conversationKeyFor(msg),
		msg,
		deps.conversations?.peekSessionId(deps.conversationKeyFor(msg)),
	);

	const text = extractPlainTextForTrigger(msg.msgType, msg.content).trim();
	// 交互选择消费——/model /resume 列出选项后，用户回复编号/名称完成选择。
	if (getPendingSelect(key)) {
		const consumed = tryConsumeSelect(key, text);
		if (consumed.consumed && consumed.text) {
			const marker = consumed.text.split(":")[0];
			const value = consumed.text.slice(consumed.text.indexOf(":") + 1);
			if (marker === "__MODEL_SELECT__") {
				const handle = await deps.conversations?.getHandle(key);
				if (handle) {
					const ok = await handle.setModel(value);
					await deps.replyTo(
						msg,
						ok
							? `✅ 模型已切换：${value}`
							: `❌ 模型 ${value} 不可用（/model 查看列表）`,
					);
				}
			} else if (marker === "__SESSION_SELECT__") {
				await deps.conversations?.switchSession(key, value);
				await deps.replyTo(msg, `✅ 已恢复会话：${value}`);
			} else if (marker === "__API_KEY__") {
				// 格式 __API_KEY__:<provider>:<key>
				const colon = value.indexOf(":");
				if (colon > 0) {
					const provider = value.slice(0, colon);
					const apiKey = value.slice(colon + 1);
					const ok = await deps.piBackend?.setProviderApiKey(provider, apiKey);
					await deps.replyTo(
						msg,
						ok
							? `✅ ${provider} API key 已保存。发送 /model 查看可用模型。`
							: `❌ ${provider} API key 保存失败。`,
					);
				}
			}
			return;
		}
	}
	if (text.startsWith("/")) {
		const cmd = parseCommand(text);
		if (cmd) {
			await deps.handleCommand(msg, cmd, text);
			return;
		}
	}
	// M4 multimedia inbound: voice → unsupported hint; attachments → pipeline.
	if (isVoiceMessage(msg)) {
		await deps.replyTo(msg, "暂不支持语音消息，请发文字或图片。");
		return;
	}
	const attachments = await processAttachments(
		msg,
		{
			download: (mid, key, type) => {
				if (!deps.transport) throw new Error("transport not started");
				return deps.transport.downloadResource(mid, key, type);
			},
		},
		{
			maxAttachments: cfg.media.maxAttachments,
			maxTotalBytes: cfg.media.maxTotalBytes,
			maxImageBytes: Math.min(cfg.media.maxTotalBytes, 10 * 1024 * 1024),
			maxTxtBytes: 2 * 1024 * 1024,
			maxExtractedChars: 150_000,
		},
	);
	for (const reason of attachments.unsupported) {
		await deps.replyTo(msg, `附件处理提示：${reason}`);
	}
	const promptText =
		[text, attachments.text].filter(Boolean).join("\n\n").trim() ||
		"(附件消息)";
	await handleConversationMessage(deps, msg, promptText, attachments.images);
}

/**
 * 对话编排（spec §6.4 / 2026-08-08）：prompt FIFO + 流式卡（streaming 开关）+
 * 空输出静默 + DONE 表情。每轮输出由持续订阅（onAssistantMessage →
 * message_end）逐条发送，turn_end 不再重复发最终结果。
 */
export async function handleConversationMessage(
	deps: MessageHandlerDeps,
	msg: FeishuInboundMessage,
	text: string,
	images: Array<{ type: "image"; data: string; mimeType: string }> = [],
): Promise<void> {
	// 解构守卫：依赖缺失时打日志（否则静默丢弃，"发消息没回复"难定位）。
	const { conversations, eventForwarder, outbox, bridgeRuntime } = deps;
	if (!conversations || !eventForwarder || !outbox || !bridgeRuntime) {
		deps.logger.info("feishu.msg.drop_missing_dep", {
			key: deps.conversationKeyFor(msg),
			missing: [
				!conversations && "conversations",
				!eventForwarder && "eventForwarder",
				!outbox && "outbox",
				!bridgeRuntime && "bridgeRuntime",
			]
				.filter(Boolean)
				.join(","),
		});
		return;
	}
	const key = deps.conversationKeyFor(msg);
	const cfg = deps.cfg();
	const turnsCfg = cfg?.turns ?? DEFAULT_CONFIG.turns;
	const route = deps.router.getRoute(key) ?? {
		sessionKey: key,
		chatId: msg.chatId,
		chatType: msg.chatType,
		threadMessageId: msg.messageId,
	};
	const routeRef = {
		conversationKey: key,
		chatId: route.chatId,
		chatType: route.chatType,
		threadMessageId: route.threadMessageId,
	};
	const runId = `run-${Date.now().toString(36)}`;
	deps.logger.info("feishu.msg.conversation", {
		key,
		text: text.slice(0, 60),
	});
	const cardId = `${key}:${runId}`;
	let streamCreated = false;

	const onDelta = (delta: string): void => {
		// streaming.enabled=false 时不流式（省流量）。
		if (!cfg?.forward.streaming.enabled) return;
		if (!streamCreated) {
			deps.streamTargets.set(cardId, {
				messageId:
					route.threadMessageId ??
					(route as { lastMessageId?: string }).lastMessageId,
				chatId: route.chatId,
			});
		}
		deps.liveChannel?.patchDelta(cardId, delta);
		streamCreated = true;
	};

	// C3: mark active feishu input so scheduler toolResults bind to this route.
	bridgeRuntime.beginFeishuInput(key);
	try {
		const finalText = await conversations.prompt(key, text, {
			turnTimeoutMs: turnsCfg.turnTimeoutMs,
			ackAfterMs: turnsCfg.ackAfterMs,
			onDelta,
			images: images.length ? images : undefined,
		});
		deps.logger.info("feishu.msg.prompt_done", {
			key,
			finalTextLen: finalText?.length ?? 0,
			finalText: (finalText ?? "").slice(0, 50),
		});
		// 空输出（如 pi-goal 激活回合）→ 静默，不打 DONE。
		if (!finalText || finalText === "No response.") {
			if (streamCreated) await deps.liveChannel?.finalize(cardId);
			return;
		}
		// 有实际回复 → 打 DONE 表情（best-effort）。
		if (cfg?.forward.reactions.enabled) {
			void deps.transport?.addReaction(
				msg.messageId,
				cfg.forward.reactions.doneEmoji || "DONE",
			);
		}
		if (streamCreated) await deps.liveChannel?.finalize(cardId);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		deps.logger.info("feishu.prompt.error", { key, error: message });
		await outbox
			.enqueue({
				dedupeKey: `error:${key}:${Date.now()}`,
				laneKey: key,
				route: routeRef,
				kind: "notify",
				payload: { type: "text", text: `处理失败：${message.slice(0, 500)}` },
			})
			.catch(() => undefined);
	} finally {
		bridgeRuntime.endFeishuInput(key);
	}
}
