import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SCHEDULER_PACKAGE = "@ineersa/my-pi-scheduler";

/**
 * 检测 pi 是否安装了 my-pi-scheduler（**可选依赖**，spec R6/FR-11）。
 *
 * 双通道探测，任一命中即视为已装：
 * 1. `~/.pi/agent/settings.json` 的 packages 列表（string 或 { source } 两种形式）
 * 2. `~/.pi/agent/npm/node_modules/@ineersa/my-pi-scheduler/package.json` 存在
 *
 * 不抛错：settings.json 缺失/损坏时静默回退到通道 2。
 * @param piAgentDir 测试可注入的 ~/.pi/agent 目录（默认按 homedir 推导）
 */
export function detectSchedulerInstalled(piAgentDir?: string): boolean {
	const piRoot = resolve(piAgentDir ?? join(homedir(), ".pi", "agent"));

	// 通道 1：settings.json packages 列表
	try {
		const settings = JSON.parse(
			readFileSync(join(piRoot, "settings.json"), "utf8"),
		) as { packages?: unknown };
		const pkgs = Array.isArray(settings?.packages) ? settings.packages : [];
		if (
			pkgs.some(
				(p) =>
					(typeof p === "string" && p.includes(SCHEDULER_PACKAGE)) ||
					(typeof p === "object" &&
						p !== null &&
						typeof (p as { source?: unknown }).source === "string" &&
						(p as { source: string }).source.includes(SCHEDULER_PACKAGE)),
			)
		) {
			return true;
		}
	} catch {
		// settings.json 缺失/损坏 → 走通道 2
	}

	// 通道 2：node_modules 实体目录
	return existsSync(
		join(
			piRoot,
			"npm",
			"node_modules",
			"@ineersa",
			"my-pi-scheduler",
			"package.json",
		),
	);
}
