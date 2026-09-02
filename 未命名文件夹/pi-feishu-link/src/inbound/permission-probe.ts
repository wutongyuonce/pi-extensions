// Group message permission probe (spec §12 #1 落地): the "获取群组中所有
// 消息" scope gates the group `open` (no-mention) policy. Feishu has no
// direct permission-query API, so we probe by listing messages of a known
// group chat: a 403/permission error → scope missing, success → present.

export type PermissionProbeResult = {
	status: "ok" | "missing" | "unknown";
	detail: string;
};

export interface PermissionProbeDeps {
	listMessages: (
		chatId: string,
		opts: { startTimeMs: number },
	) => Promise<unknown>;
	groupChatIds: () => string[];
}

const PERMISSION_CODES = new Set([403, 402, 91402, 200003, 230002]);

export async function probeGroupMessagePermission(
	deps: PermissionProbeDeps,
): Promise<PermissionProbeResult> {
	const chatIds = deps.groupChatIds().filter((id) => id.length > 0);
	if (chatIds.length === 0) {
		return { status: "unknown", detail: "暂无群会话可探测（群 open 策略需机器人拥有该权限）" };
	}
	for (const chatId of chatIds) {
		try {
			await deps.listMessages(chatId, { startTimeMs: Date.now() - 60_000 });
			return { status: "ok", detail: "可以读取群消息（open 策略可用）" };
		} catch (err) {
			const code = (err as { code?: unknown })?.code;
			const msg = err instanceof Error ? err.message : String(err);
			if (typeof code === "number" && PERMISSION_CODES.has(code)) {
				return {
					status: "missing",
					detail: `缺少“获取群组中所有消息”权限（code ${code}）。请到飞书开发者后台 → 权限管理 开启，或将群策略改为 mention。`,
				};
			}
			if (/permission|forbidden|scope|denied/i.test(msg)) {
				return { status: "missing", detail: `权限不足：${msg.slice(0, 120)}` };
			}
		}
	}
	return {
		status: "unknown",
		detail: "所有群会话探测均失败（网络/接口问题），无法确认权限状态",
	};
}
