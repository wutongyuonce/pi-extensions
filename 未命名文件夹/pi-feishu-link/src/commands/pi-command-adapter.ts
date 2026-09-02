// Command adapter (spec 2026-08-08-1400 §3.2/§3.3): pi 内置命令 → AgentSession API。
// 纯编排 + 依赖注入（getHandle/listModels/listSessions/...），可单测。
//
// 输入分流（§3.2.1）：
//   桥特有命令 → 桥处理（index.ts handleCommand 保留）
//   pi 内置命令 → 本模块（runPiCommand）
//   其他（插件/skill/模板/未知）→ 原样交 prompt()（pi 原生执行）

import type {
	ModelInfo,
	PiSessionHandle,
	SessionListItem,
} from "../sessions/conversation-manager.js";
import type { ConversationKey } from "../common/types.js";

export type AdapterResult =
	| { kind: "handled"; text: string }
	| { kind: "forward" };

export interface PiCommandDeps {
	getHandle(key: ConversationKey): Promise<PiSessionHandle | undefined>;
	listModels(): Promise<ModelInfo[]>;
	listSessions(): Promise<SessionListItem[]>;
	newConversation(key: ConversationKey): Promise<void>;
	switchSession(key: ConversationKey, path: string): Promise<void>;
	/** 2026-08-08 /login API key 通道：写入 provider 凭据。 */
	setProviderApiKey(provider: string, apiKey: string): Promise<boolean>;
}

/** pi 内置命令清单（interactive-mode.js 提取，2026-08-08）。 */
export const PI_COMMANDS: readonly string[] = [
	"model",
	"scoped-models",
	"thinking",
	"compact",
	"new",
	"resume",
	"sessions",
	"name",
	"session",
	"copy",
	"help",
	"login",
	"logout",
	"settings",
	"export",
	"import",
	"share",
	"changelog",
	"hotkeys",
	"reload",
	"debug",
	"quit",
	"fork",
	"clone",
	"tree",
] as const;

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** 交互选择等待态（模型/会话列表选择）。 */
export interface PendingSelect {
	kind: "model" | "session";
	options: Array<{ index: number; label: string; value: string }>;
	expiresAt: number;
}

export const SELECT_TTL_MS = 60_000;

export function isPiCommand(command: string): boolean {
	return (PI_COMMANDS as readonly string[]).includes(command);
}

function listOptions(items: Array<{ label: string; value: string }>): {
	options: PendingSelect["options"];
	text: string;
} {
	const options = items.map((it, i) => ({ index: i + 1, ...it }));
	const text = options.map((o) => `${o.index}) ${o.label}`).join("\n");
	return { options, text };
}

/** 从用户回复解析选择：纯数字 → index；否则按 label 精确/包含匹配。 */
export function resolveSelect(
	text: string,
	options: PendingSelect["options"],
): string | undefined {
	const t = text.trim();
	const asNum = Number(t);
	if (Number.isInteger(asNum) && asNum >= 1 && asNum <= options.length) {
		return options[asNum - 1]!.value;
	}
	const lower = t.toLowerCase();
	const hit = options.find((o) => o.label.toLowerCase() === lower);
	if (hit) return hit.value;
	const partial = options.find((o) => o.label.toLowerCase().includes(lower));
	if (partial && lower.length > 2) return partial.value;
	return undefined;
}

export interface RunCommandInput {
	key: ConversationKey;
	command: string;
	args: string[];
	rawText: string;
}

export async function runPiCommand(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const { command } = input;
	switch (command) {
		case "model":
			return handleModel(deps, input);
		case "thinking":
			return handleThinking(deps, input);
		case "compact":
			return handleCompact(deps, input);
		case "new":
			await deps.newConversation(input.key);
			return {
				kind: "handled",
				text: "已创建新会话（pi newSession）。旧会话历史已保留。",
			};
		case "resume":
			return handleResume(deps, input);
		case "sessions":
			// 2026-08-08 用户指令：/sessions 列会话（同 /resume，不恢复时只看列表）
			return handleResume(deps, input);
		case "name":
			return handleName(deps, input);
		case "session":
			return handleSession(deps, input);
		case "copy":
			return handleCopy(deps, input);
		case "help":
			return { kind: "handled", text: buildHelpText() };
		// ---- 降级（P1/P2）：提示在 pi 终端执行或给出替代 ----
		case "login":
			return handleLogin(deps, input);
		case "logout":
			return {
				kind: "handled",
				text: "⚠️ /logout 请到 pi 终端执行（或在桥内 /feishu-config 调整）。",
			};
		case "settings":
			return {
				kind: "handled",
				text: "⚠️ /settings 为 pi 交互式设置面板，请在 pi 终端打开。桥内可发送 /feishu-config <key>=<value> 热改桥配置。",
			};
		case "export":
			return {
				kind: "handled",
				text: "⚠️ /export 请到 pi 终端执行（导出当前会话 HTML）。",
			};
		case "import":
		case "share":
			return {
				kind: "handled",
				text: `⚠️ /${command} 请到 pi 终端执行。`,
			};
		case "changelog":
			return {
				kind: "handled",
				text: "pi 更新日志：npm 包 @earendil-works/pi-coding-agent（README/CHANGELOG）。",
			};
		case "hotkeys":
			return {
				kind: "handled",
				text: "pi 快捷键参考 docs/keybindings.md（本机：~/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md）。",
			};
		case "reload":
			return {
				kind: "handled",
				text: "⚠️ /reload 需重启 daemon 生效。桥内发送 /feishu restart 触发。",
			};
		case "debug":
			return {
				kind: "handled",
				text: "调试日志：桥 daemon 日志位于 ~/.pi/agent/feishu-link/（daemon.log/events-*.jsonl）。",
			};
		case "quit":
			return {
				kind: "handled",
				text: "⚠️ 飞书内 /quit 不退出 daemon（桥常驻）。停止请用 /stop 或卸载。",
			};
		case "fork":
		case "clone":
		case "tree":
		case "scoped-models":
			return {
				kind: "handled",
				text: `⚠️ /${command} 暂未在飞书适配（涉及 pi 交互式选择器），请到 pi 终端执行。`,
			};
		default:
			return { kind: "forward" };
	}
}

// ---- handlers ----

/**
 * 2026-08-08 /login API key 通道（用户指令：不用浏览器 OAuth）：
 * - /login <provider> <key> → 直接写入 auth.json
 * - /login <provider> → 进入交互：下一条消息即视为 key
 * - /login → 用法提示
 */
async function handleLogin(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const { args } = input;
	if (args.length >= 2) {
		const provider = args[0]!;
		const apiKey = args.slice(1).join(" ").trim();
		if (!apiKey) {
			return {
				kind: "handled",
				text: "❌ API key 为空。用法：/login <provider> <apiKey>",
			};
		}
		const ok = await deps.setProviderApiKey(provider, apiKey);
		return {
			kind: "handled",
			text: ok
				? `✅ ${provider} API key 已保存。发送 /model 查看可用模型。`
				: `❌ ${provider} API key 保存失败（provider 可能不支持 api_key）。`,
		};
	}
	if (args.length === 1) {
		pendingApiKeys.set(input.key, {
			provider: args[0]!,
			expiresAt: Date.now() + SELECT_TTL_MS,
		});
		return {
			kind: "handled",
			text: `请发送 ${args[0]} 的 API key（下一条消息直接发 key 即可，60 秒内）：`,
		};
	}
	return {
		kind: "handled",
		text: `用法：\n/login <provider> <apiKey>（直接保存）\n/login <provider>（交互输入 key）\n已认证 provider：发送 /model 查看可用模型列表。`,
	};
}

async function handleModel(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const { args } = input;
	const handle = await deps.getHandle(input.key);
	if (args.length > 0 && handle) {
		const ok = await handle.setModel(args[0]!);
		return {
			kind: "handled",
			text: ok
				? `✅ 模型已切换：${args[0]}`
				: `❌ 模型 ${args[0]} 未配置或缺少凭据。发送 /model 查看可用列表。`,
		};
	}
	const models = await deps.listModels();
	if (models.length === 0) {
		return {
			kind: "handled",
			text: "无可用模型（请先在 pi 终端 /login 或配置凭据）。",
		};
	}
	const { options, text } = listOptions(
		models.map((m) => ({
			label: `${m.provider}/${m.id}${
				m.contextWindow ? ` (ctx ${m.contextWindow})` : ""
			}${m.reasoning ? " ⚡思考" : ""}`,
			value: m.id,
		})),
	);
	pendingSelects.set(input.key, {
		kind: "model",
		options,
		expiresAt: Date.now() + SELECT_TTL_MS,
	});
	return {
		kind: "handled",
		text: `可切换模型：\n${text}\n\n回复编号或模型 ID 切换（当前：${handle?.getModelLabel() ?? "default"}）。`,
	};
}

async function handleThinking(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const { args } = input;
	const handle = await deps.getHandle(input.key);
	if (!handle) return { kind: "handled", text: "会话未就绪，请稍后重试。" };
	const requested = args[0]?.toLowerCase();
	if (requested && (THINKING_LEVELS as readonly string[]).includes(requested)) {
		await handle.setThinkingLevel(requested);
		return { kind: "handled", text: `✅ 思考等级已设为 ${requested}。` };
	}
	const levels = handle.getAvailableThinkingLevels();
	const valid = levels.length > 0 ? levels : [...THINKING_LEVELS];
	return {
		kind: "handled",
		text: `当前思考等级：${handle.getThinkingLevel()}\n可用：${valid.join(" / ")}\n用法：/thinking <level>`,
	};
}

async function handleCompact(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const { args } = input;
	const handle = await deps.getHandle(input.key);
	if (!handle) return { kind: "handled", text: "会话未就绪，请稍后重试。" };
	try {
		const text = await handle.compact(args.join(" ") || undefined);
		return { kind: "handled", text: `✅ ${text}` };
	} catch (err) {
		return {
			kind: "handled",
			text: `❌ 压缩失败：${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

async function handleResume(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const { args } = input;
	if (args.length > 0) {
		// /resume <path> 直接恢复
		await deps.switchSession(input.key, args[0]!);
		return { kind: "handled", text: `✅ 已恢复会话：${args[0]}` };
	}
	const sessions = await deps.listSessions();
	if (sessions.length === 0) {
		return { kind: "handled", text: "没有可恢复的历史会话。" };
	}
	const { options, text } = listOptions(
		sessions.slice(0, 15).map((s) => ({
			label: `${s.name || s.firstMessage || "未命名"} (${s.messageCount}条, ${
				s.cwd ? s.cwd : "?"
			})`,
			value: s.path,
		})),
	);
	pendingSelects.set(input.key, {
		kind: "session",
		options,
		expiresAt: Date.now() + SELECT_TTL_MS,
	});
	return {
		kind: "handled",
		text: `历史会话（前 15 个）：\n${text}\n\n回复编号恢复，或 /resume <路径>。`,
	};
}

async function handleName(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const { args } = input;
	const handle = await deps.getHandle(input.key);
	if (!handle) return { kind: "handled", text: "会话未就绪。" };
	if (args.length > 0) {
		await handle.setSessionName(args.join(" "));
		return { kind: "handled", text: `✅ 会话已命名为：${args.join(" ")}` };
	}
	return {
		kind: "handled",
		text: `用法：/name <名称>（当前会话 ${handle.getSessionSummary().name ?? "未命名"}）`,
	};
}

async function handleSession(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const handle = await deps.getHandle(input.key);
	if (!handle) return { kind: "handled", text: "会话未就绪。" };
	const s = handle.getSessionSummary();
	return {
		kind: "handled",
		text: `会话信息：\n模型：${s.modelId}\n消息数：${s.messageCount}\n名称：${s.name ?? "未命名"}`,
	};
}

async function handleCopy(
	deps: PiCommandDeps,
	input: RunCommandInput,
): Promise<AdapterResult> {
	const handle = await deps.getHandle(input.key);
	if (!handle) return { kind: "handled", text: "会话未就绪。" };
	const text = handle.getLastAssistantText();
	return {
		kind: "handled",
		text: text ? `最近回复：\n${text.slice(0, 1000)}` : "暂无最近回复。",
	};
}

function buildHelpText(): string {
	const bridge = ["status", "workspace", "stop", "doctor", "feishu-config"];
	const native = [
		"model",
		"thinking",
		"compact",
		"new",
		"resume",
		"name",
		"session",
		"copy",
		"login",
	];
	return `桥命令：/${bridge.join(" /")}\npi 原生命令（已适配）：/${native.join(
		" /",
	)}\n其他 / 命令原样转发 pi（插件/skill/模板）。`;
}

// ---- 交互选择状态（per-key，进程内） ----

const pendingSelects = new Map<ConversationKey, PendingSelect>();

/** 2026-08-08 /login API key 交互：provider → 等待用户下一条消息作为 key。 */
const pendingApiKeys = new Map<
	ConversationKey,
	{ provider: string; expiresAt: number }
>();

export function getPendingSelect(
	key: ConversationKey,
): PendingSelect | undefined {
	const p = pendingSelects.get(key);
	if (!p) return undefined;
	if (Date.now() > p.expiresAt) {
		pendingSelects.delete(key);
		return undefined;
	}
	return p;
}

export function clearPendingSelect(key: ConversationKey): void {
	pendingSelects.delete(key);
	pendingApiKeys.delete(key);
}

/** 尝试把用户回复解析为一次选择；返回 { consumed, text? }。 */
export function tryConsumeSelect(
	key: ConversationKey,
	text: string,
): { consumed: boolean; text?: string } {
	// 2026-08-08 /login API key 通道：pending 状态下，下一条消息即视为 key。
	const apiPending = pendingApiKeys.get(key);
	if (apiPending) {
		pendingApiKeys.delete(key);
		if (Date.now() > apiPending.expiresAt) return { consumed: false };
		const trimmed = text.trim();
		if (!trimmed) return { consumed: false };
		return {
			consumed: true,
			text: `__API_KEY__:${apiPending.provider}:${trimmed}`,
		};
	}
	const p = getPendingSelect(key);
	if (!p) return { consumed: false };
	const value = resolveSelect(text, p.options);
	if (value === undefined) return { consumed: false };
	pendingSelects.delete(key);
	if (p.kind === "model") {
		return { consumed: true, text: `__MODEL_SELECT__:${value}` };
	}
	return { consumed: true, text: `__SESSION_SELECT__:${value}` };
}
