// TUI 状态行文本（2026-08-07）：状态行在 session_start 只设置一次，
// setup/start/stop 等命令成功后需要刷新 —— 纯函数保证可单测、各路径一致。

import type { FeishuConfig } from "./types.js";
import type { GatewayOwner } from "../host/gateway-lock.js";

export type ConnectionStatus =
	| "unconfigured"
	| "configured_stopped"
	| "daemon_running"
	| "self_running";

export function classifyConnectionStatus(
	cfg: FeishuConfig | undefined,
	owner: GatewayOwner | undefined,
	selfPid: number,
): ConnectionStatus {
	if (!cfg) return "unconfigured";
	if (owner && owner.pid !== selfPid) return "daemon_running";
	if (owner && owner.pid === selfPid) return "self_running";
	return "configured_stopped";
}

/** 供 /feishu 命令成功后刷新 TUI 状态行的文本。 */
export function connectionStatusText(
	cfg: FeishuConfig | undefined,
	owner: GatewayOwner | undefined,
	selfPid: number,
): string {
	switch (classifyConnectionStatus(cfg, owner, selfPid)) {
		case "unconfigured":
			return "飞书桥未配置 → 运行 /feishu setup";
		case "daemon_running":
			return `飞书桥运行中（daemon pid ${owner?.pid ?? "?"}）`;
		case "self_running":
			return "飞书桥已连接（本进程持有）";
		case "configured_stopped":
			return "飞书桥已配置，未运行 → /feishu start";
	}
}
