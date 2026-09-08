// DDD 应用层（spec 2026-08-08-1700 Step 1）：状态行/明细格式化——纯函数，
// 从 index.ts 搬移（依赖参数化：StatusSnapshot 传入，now 可注入测试）。

import type { StatusSnapshot } from "../common/types.js";

const STATE_LABELS: Record<string, string> = {
	connected: "🟢 已连接",
	connecting: "🟡 连接中",
	degraded: "🟠 降级",
	restarting: "🟠 重启中",
	disconnected: "🔴 已断开",
};

export function formatStatusLine(
	s: StatusSnapshot,
	now: () => number = Date.now,
): string {
	return `${STATE_LABELS[s.connState] ?? s.connState} · 运行 ${Math.round((now() - s.startedAt) / 60_000)}min`;
}

export function statusDetailLines(s: StatusSnapshot): string[] {
	return [
		`入站 ${s.inboundCount} / 出站 ${s.outboundCount} / outbox 积压 ${s.outboxPending}`,
		`重连 ${s.reconnectCount} 次 · 会话 ${s.residentSessions}/${s.maxResident}`,
		`定时任务路由 ${s.boundJobs} 个`,
	];
}
