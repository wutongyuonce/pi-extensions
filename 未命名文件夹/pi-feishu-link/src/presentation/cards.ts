// Card builders (spec §9 懒人 UX): welcome card, command help card,
// approval card, status card. Pure functions producing Feishu card JSON.
//
// 2026-08-14 修复：飞书卡片 schema 2.0 不再支持 tag:"action" 容器
// （ErrCode 200861）——按钮直接放 body.elements（tag:"button"），
// 交互回传用 behaviors:[{type:"callback",value}]。
// 2026-08-14 二次修复：按钮直接平铺（每按钮一行，宽度完整、不缩略）——
// 此前 column_set flow 布局把按钮挤成省略号；emoji 精简为稳定集合
// （部分 emoji 如 🩺⚙️ 在部分客户端字体渲染乱码）。

export interface CardButton {
	text: string;
	value: Record<string, unknown>;
	buttonType?: "primary" | "danger" | "default";
}

export function buildWelcomeCard(botName: string): unknown {
	return {
		schema: "2.0",
		body: {
			elements: [
				{
					tag: "markdown",
					content: `**${botName} 已连接**\n\n你可以直接和我说话，或点下方按钮：`,
				},
				button("命令面板", { op: "help" }),
				button("切换模型", { op: "model" }),
				button("状态", { op: "status" }),
			],
		},
	};
}

export function buildHelpCard(): unknown {
	return {
		schema: "2.0",
		body: {
			elements: [
				{
					tag: "markdown",
					content: "**命令面板**\n点击按钮一键执行，或直接输入文字聊天：",
				},
				button("新会话", { op: "new" }),
				button("历史会话", { op: "resume" }),
				button("切换模型", { op: "model" }),
				button("思考等级", { op: "thinking" }),
				button("停止", { op: "stop" }),
				button("工作区", { op: "workspace" }),
				button("状态", { op: "status" }),
				button("压缩上下文", { op: "compact" }),
				button("诊断包", { op: "doctor" }),
				button("配置", { op: "feishu-config" }),
				{
					tag: "markdown",
					content:
						'文本命令：`/new` `/resume` `/model` `/stop` `/workspace /路径` `/status` `/help` `/doctor`\n\n定时任务：直接说"每天 9 点提醒我喝水"即可创建。',
				},
			],
		},
	};
}

export function buildApprovalCard(
	approvalId: string,
	toolName: string,
	paramsText: string,
	dangerous = false,
): unknown {
	const banner = dangerous
		? "**危险命令**——该命令匹配破坏性黑名单（如 `rm -rf /`、`curl … | sh`），确认后再批准。\n\n"
		: "";
	return {
		schema: "2.0",
		body: {
			elements: [
				{
					tag: "markdown",
					content: `**工具审批**\n\n${banner}**${toolName}** 请求执行：\n\n\`\`\`\n${paramsText.slice(0, 500)}\n\`\`\`\n\n${dangerous ? "批准后本次会话不再询问（可配置关闭）——仅管理员可审批。" : "仅管理员可审批；批准后本次会话不再询问（可配置关闭）。"}`,
				},
				button("批准", { op: "approve", approvalId }, "primary"),
				button("拒绝", { op: "deny", approvalId }, "danger"),
			],
		},
	};
}

export function buildStatusCard(
	statusText: string,
	detailLines: string[],
): unknown {
	return {
		schema: "2.0",
		body: {
			elements: [
				{ tag: "markdown", content: `**状态**\n${statusText}` },
				...detailLines.map((line) => ({ tag: "markdown", content: line })),
				button("诊断包", { op: "doctor" }),
			],
		},
	};
}

export function buildSimpleTextCard(text: string): unknown {
	return {
		schema: "2.0",
		body: { elements: [{ tag: "markdown", content: text }] },
	};
}

/**
 * schema 2.0 按钮：直接作为组件放 elements（平铺，宽度完整不缩略）；
 * 交互回传用 behaviors:[{type:"callback",value}]（card.action.trigger 回调返回 value）。
 */
function button(
	text: string,
	value: Record<string, unknown>,
	buttonType: CardButton["buttonType"] = "default",
): unknown {
	const b: Record<string, unknown> = {
		tag: "button",
		width: "fill", // 2026-08-14：默认宽度太窄（文字被截）——撑满卡片宽度
		text: { tag: "plain_text", content: text },
		behaviors: [{ type: "callback", value }],
	};
	if (buttonType && buttonType !== "default") b.type = buttonType;
	return b;
}
