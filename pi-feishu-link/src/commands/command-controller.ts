// Command parsing（spec §8 简化 2026-08-08）：
// 2026-08-08 命令体系演进后，桥命令分发由 application/command-router 处理、
// pi 原生命令由 commands/pi-command-adapter 处理——本模块只保留 / 消息解析
// 纯函数（parseCommand，被 message-handler 使用）。classifyCommand /
// shouldMarkDoneCommand 等旧矩阵已移除（全部放开，无 blocked/admin 门禁）。

export interface ParsedCommand {
	name: string;
	rawArgs: string;
	args: string[];
}

/** Parse "/name arg1 arg2" → { name, args }. Returns undefined if not a command. */
export function parseCommand(text: string): ParsedCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const parts = trimmed.slice(1).split(/\s+/);
	const name = parts[0] ?? "";
	if (!name) return null;
	return {
		name: name.toLowerCase(),
		rawArgs: trimmed.slice(1 + name.length).trim(),
		args: parts.slice(1).filter((a) => a.length > 0),
	};
}
