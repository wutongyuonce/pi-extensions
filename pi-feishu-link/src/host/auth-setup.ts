// One-click auth (spec §6.8 / R3): scan a QR code (or open the link) to
// create the Feishu/Lark app automatically via lark.registerApp; manual
// AppID/Secret entry as fallback.
//
// 实机验证发现（2026-08-07，spec 开放问题 #1）：registerApp 扫码创建的
// 应用默认只订阅 card.action.trigger，**不会**订阅 im.message.receive_v1
// （消息事件），导致 WS 连上但收不到任何消息。必须通过 addons 在创建时
// 显式订阅；创建后可再 verifyEventSubscription 自检兜底。

import type { FeishuConfig, Domain, GroupPolicy } from "../common/types.js";
import { DEFAULT_CONFIG, saveConfig } from "../common/config.js";

/**
 * registerApp 的 addons 载荷（launcher 创建应用时应用配置）：
 * - events.items.tenant：租户级事件订阅（消息事件入口）
 * - callbacks.items：回调订阅（卡片动作）
 * - scopes.tenant：权限范围（发消息/读消息/群组/资源）
 */
export interface SetupAddons {
	scopes?: { tenant?: string[]; user?: string[] };
	events?: { items?: { tenant?: string[]; user?: string[] } };
	callbacks?: { items?: string[] };
}

/** 桥接必需的事件订阅：im.message.receive_v1（消息到达） */
export const REQUIRED_EVENT = "im.message.receive_v1";
/** 桥接依赖的权限范围（2026-08-08 扩充：群聊全量消息 + 表情回执） */
export const SETUP_SCOPES: readonly string[] = [
	"im:message",
	"im:message.send_as_bot",
	"im:chat",
	"im:resource",
	"im:message.group_msg", // 群聊所有消息（不@也推，用户指令 2026-08-08）
	"im:message.reactions:write_only", // DONE 表情回执（命令/任务完成标记）
] as const;

/** 构建 registerApp 的 addons（纯函数，可单测）。 */
export function buildSetupAddons(): SetupAddons {
	return {
		scopes: { tenant: [...SETUP_SCOPES] },
		events: { items: { tenant: [REQUIRED_EVENT] } },
		callbacks: { items: ["card.action.trigger"] },
	};
}

export interface RegisterAppResult {
	appId: string;
	appSecret: string;
	domain: Domain;
}

export interface RegisterAppCallbacks {
	onQRCodeReady(url: string, expireInSec: number): void;
	onStatusChange?(info: { status?: string }): void;
}

export type RegisterAppFn = (callbacks: RegisterAppCallbacks) => Promise<{
	client_id?: string;
	client_secret?: string;
	user_info?: { tenant_brand?: string };
}>;

export interface SetupInput {
	mode: "auto" | "manual";
	registerApp?: RegisterAppFn;
	appId?: string;
	appSecret?: string;
	domain?: Domain;
	groupPolicy: GroupPolicy;
	/** UX 阶段回调（2026-08-07）：creating → callback → saved，供 TUI 展示进度 */
	onStage?: (stage: "creating" | "callback" | "saved") => void;
}

/** Run setup; returns the persisted config. */
export async function runSetup(input: SetupInput): Promise<FeishuConfig> {
	let appId = "";
	let appSecret = "";
	let domain: Domain = input.domain ?? "feishu";
	if (input.mode === "auto") {
		if (!input.registerApp) throw new Error("registerApp 未提供");
		input.onStage?.("creating");
		// The caller's registerApp implementation handles QR/link printing itself
		// (index.ts prints via qrcode-terminal inside its closure).
		const result = await input.registerApp({
			onQRCodeReady: () => {
				/* caller prints; nothing to do here */
			},
		});
		if (!result.client_id || !result.client_secret) {
			throw new Error("扫码创建应用失败：未拿到凭据");
		}
		appId = result.client_id;
		appSecret = result.client_secret;
		domain = result.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
		input.onStage?.("callback");
	} else {
		appId = (input.appId ?? "").trim();
		appSecret = (input.appSecret ?? "").trim();
		if (!appId || !appSecret) throw new Error("需要 AppID 和 AppSecret");
	}
	const config: FeishuConfig = {
		...DEFAULT_CONFIG,
		appId,
		appSecret,
		domain,
		groupPolicy: input.groupPolicy,
	};
	saveConfig(config);
	input.onStage?.("saved");
	return config;
}

/**
 * 创建后自检：读取应用配置确认事件订阅包含 REQUIRED_EVENT。
 * 返回诊断结果（无 HTTP 依赖时跳过，可注入 fetcher 单测）。
 */
export interface EventSubscriptionCheck {
	ok: boolean;
	subscribed: string[];
	missing: string[];
	error?: string;
}

export async function checkEventSubscription(
	appId: string,
	appSecret: string,
	opts: {
		domain?: Domain;
		fetch?: typeof globalThis.fetch;
	} = {},
): Promise<EventSubscriptionCheck> {
	const base =
		opts.domain === "lark"
			? "https://open.larksuite.com"
			: "https://open.feishu.cn";
	const fetcher = opts.fetch ?? globalThis.fetch;
	try {
		const tokenRes = await fetcher(
			`${base}/open-apis/auth/v3/tenant_access_token/internal`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
			},
		);
		const token = (await tokenRes.json()) as { tenant_access_token?: string };
		if (!token.tenant_access_token) {
			return {
				ok: false,
				subscribed: [],
				missing: [REQUIRED_EVENT],
				error: "token 获取失败",
			};
		}
		const appRes = await fetcher(
			`${base}/open-apis/application/v6/applications/${appId}?lang=zh_cn`,
			{ headers: { Authorization: `Bearer ${token.tenant_access_token}` } },
		);
		const body = (await appRes.json()) as {
			code?: number;
			data?: {
				app?: {
					callback_info?: { subscribed_callbacks?: string[] };
				};
			};
		};
		const subscribed =
			body.data?.app?.callback_info?.subscribed_callbacks ?? [];
		const missing = subscribed.includes(REQUIRED_EVENT) ? [] : [REQUIRED_EVENT];
		return { ok: missing.length === 0, subscribed, missing };
	} catch (err) {
		return {
			ok: false,
			subscribed: [],
			missing: [REQUIRED_EVENT],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
