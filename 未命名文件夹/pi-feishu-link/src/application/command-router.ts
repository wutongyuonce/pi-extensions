// DDD 应用层（spec 2026-08-08-1700 Step 3）：命令分发路由——handleCommand 从
// index.ts 迁出，依赖注入（CommandRouterDeps），可单测。

import type { ConversationManager } from "../sessions/conversation-manager.js";
import type { PiSessionBackend } from "../sessions/pi-session-backend.js";
import type { StatusStore } from "../common/status.js";
import type { FeishuInboundMessage } from "../common/types.js";
import {
	isPiCommand,
	runPiCommand,
	type PiCommandDeps,
} from "../commands/pi-command-adapter.js";
import type { StatusSnapshot } from "../common/types.js";

export interface CommandRouterDeps {
	conversations?: ConversationManager;
	piBackend?: PiSessionBackend;
	statusStore: StatusStore;
	conversationKeyFor(msg: FeishuInboundMessage): string;
	replyTo(
		msg: FeishuInboundMessage,
		textOrCard: string | unknown,
	): Promise<void>;
	markDone(msg: FeishuInboundMessage): void;
	exportDiagnostics(msg: FeishuInboundMessage): Promise<void>;
	handleConversationMessage(
		msg: FeishuInboundMessage,
		text: string,
	): Promise<void>;
	detectSchedulerInstalled(): boolean;
	// 卡片构建（presentation）
	buildHelpCard(): unknown;
	buildStatusCard(line: string, details: string[]): unknown;
	buildSimpleTextCard(text: string): unknown;
	formatStatusLine(s: StatusSnapshot): string;
	statusDetailLines(s: StatusSnapshot): string[];
}

const BRIDGE_COMMANDS = [
	"help",
	"status",
	"stop",
	"workspace",
	"doctor",
	"feishu-config",
	// 2026-08-14：support 改名 doctor，旧名保留兼容。
	"support",
] as const;

const SCHEDULER_COMMANDS = [
	"loop",
	"remind",
	"schedule",
	"unschedule",
] as const;

/**
 * 命令分发（spec 2026-08-08-1400 §3.2.1 三级分流）：
 * 桥特有命令 → 桥处理；pi 内置命令 → CommandAdapter；其他 → 原样转发。
 */
export async function handleCommand(
	deps: CommandRouterDeps,
	msg: FeishuInboundMessage,
	cmd: { name: string; rawArgs: string; args: string[] },
	rawText: string,
): Promise<void> {
	const key = deps.conversationKeyFor(msg);
	const name = cmd.name;
	// 1) 桥特有命令
	if ((BRIDGE_COMMANDS as readonly string[]).includes(name)) {
		switch (name) {
			case "help":
				await deps.replyTo(msg, deps.buildHelpCard());
				break;
			case "status":
				await deps.replyTo(
					msg,
					deps.buildStatusCard(
						deps.formatStatusLine(deps.statusStore.get()),
						deps.statusDetailLines(deps.statusStore.get()),
					),
				);
				break;
			case "stop":
				await deps.conversations?.disposeActiveFor(key);
				await deps.replyTo(msg, "已停止当前任务。");
				break;
			case "workspace":
				try {
					const ws = await deps.conversations?.switchWorkspace(
						key,
						cmd.args[0],
					);
					await deps.replyTo(msg, `当前工作区：${ws ?? "未切换"}`);
				} catch (err) {
					await deps.replyTo(
						msg,
						`工作区切换失败：${err instanceof Error ? err.message : String(err)}`,
					);
				}
				break;
			case "support":
			case "doctor": {
				await deps.exportDiagnostics(msg);
				break;
			}
			case "feishu-config":
				await deps.replyTo(
					msg,
					deps.buildSimpleTextCard(
						"配置：发送 /feishu-config <key>=<value> 热改（如 groupPolicy=mention）。",
					),
				);
				break;
		}
		deps.markDone(msg);
		return;
	}
	// 2) pi 内置命令 → CommandAdapter
	if (isPiCommand(name)) {
		const piAdapterDeps: PiCommandDeps = {
			getHandle: (k) =>
				deps.conversations?.getHandle(k) ?? Promise.resolve(undefined),
			listModels: () => deps.conversations?.listModels() ?? Promise.resolve([]),
			listSessions: () =>
				deps.conversations?.listSessions("all") ?? Promise.resolve([]),
			newConversation: (k) =>
				deps.conversations?.newConversation(k) ?? Promise.resolve(),
			switchSession: (k, p) =>
				deps.conversations?.switchSession(k, p) ?? Promise.resolve(),
			setProviderApiKey: (provider, apiKey) =>
				deps.piBackend?.setProviderApiKey(provider, apiKey) ??
				Promise.resolve(false),
		};
		const res = await runPiCommand(piAdapterDeps, {
			key,
			command: name,
			args: cmd.args,
			rawText,
		});
		if (res.kind === "handled") {
			await deps.replyTo(msg, deps.buildSimpleTextCard(res.text));
			deps.markDone(msg);
		} else {
			// 适配器不处理（防御）→ 原样转发
			await deps.handleConversationMessage(msg, rawText);
		}
		return;
	}
	// 3) scheduler（可选依赖，FR-11）
	if ((SCHEDULER_COMMANDS as readonly string[]).includes(name)) {
		if (!deps.detectSchedulerInstalled()) {
			await deps.replyTo(
				msg,
				deps.buildSimpleTextCard(
					"⏰ 定时任务功能需要安装 my-pi-scheduler（可选依赖，不影响其他功能）。\n\n在 pi 终端运行：\n  pi install npm:@ineersa/my-pi-scheduler\n\n重启 pi 后即可使用 /loop、/remind、/schedule 或在聊天里直接说「每天 9 点总结 commit」。",
				),
			);
			return;
		}
		await deps.handleConversationMessage(
			msg,
			`/${cmd.name} ${cmd.rawArgs}`.trim(),
		);
		return;
	}
	// 4) 其他（插件命令/skill/模板/未知）→ 原样交 prompt（pi 原生执行）
	await deps.handleConversationMessage(msg, rawText);
}
