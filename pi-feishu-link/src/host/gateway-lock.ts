// Gateway lock (spec ADR-5 / M7): a pid-based file lock that elects a single
// "gateway owner" process across pi instances (TUI + daemon). Followers can
// attach read-only. Adapted from the reference implementation's approach.

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface GatewayOwner {
	pid: number;
	startedAt: number;
	status: "starting" | "connected" | "stopping";
}

export interface GatewayLockHandle {
	owner: GatewayOwner;
	release(): Promise<void>;
	update(status: GatewayOwner["status"]): void;
}

export interface GatewayLockResult {
	status: "acquired" | "busy";
	handle?: GatewayLockHandle;
	owner?: GatewayOwner;
}

function readOwner(filePath: string): GatewayOwner | undefined {
	try {
		if (!existsSync(filePath)) return undefined;
		const raw = JSON.parse(readFileSync(filePath, "utf8")) as GatewayOwner;
		return raw && typeof raw.pid === "number" ? raw : undefined;
	} catch {
		return undefined;
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function acquireGatewayLock(
	dir: string,
	opts: { takeover?: boolean; now?: () => number; pid?: number } = {},
): GatewayLockResult {
	const filePath = join(dir, "gateway.json");
	const pid = opts.pid ?? process.pid;
	const now = opts.now ?? Date.now;
	const owner: GatewayOwner = { pid, startedAt: now(), status: "starting" };
	// 2026-08-08 竞态根治：wx 独占创建（文件已存在即失败）——消除并发
	// read-then-write 双写锁（多个 pi TUI 窗口同时 autoStart spawn daemon 时
	// 两个 daemon 都读到"无 owner"→ 都写锁 → 双 owner 双连接）。
	const tryCreate = (): boolean => {
		try {
			writeFileSync(filePath, JSON.stringify(owner, null, 2), {
				flag: "wx",
			});
			return true;
		} catch {
			return false;
		}
	};
	if (!tryCreate()) {
		const existing = readOwner(filePath);
		if (existing && existing.pid !== pid && isPidAlive(existing.pid)) {
			// 活 owner：takeover 时 kill 后重试；否则 busy。
			if (opts.takeover) {
				// 防御：不 kill 自己（同进程重入/测试用 process.pid 模拟活 owner）。
				if (existing.pid !== process.pid) {
					try {
						process.kill(existing.pid, "SIGKILL");
					} catch {
						/* ignore */
					}
				}
				rmSync(filePath, { force: true });
				if (!tryCreate()) return { status: "busy", owner: existing };
			} else {
				return { status: "busy", owner: existing };
			}
		} else if (existing) {
			// 僵尸锁（owner 已死）→ 清掉重试。
			rmSync(filePath, { force: true });
			if (!tryCreate()) return { status: "busy", owner: existing };
		} else {
			// 锁文件损坏/无法读 → busy（保守）。
			return { status: "busy", owner: existing };
		}
	}
	let released = false;
	const update = (status: GatewayOwner["status"]): void => {
		if (released) return;
		owner.status = status;
		try {
			writeFileSync(filePath, JSON.stringify(owner, null, 2), "utf8");
		} catch {
			/* ignore */
		}
	};
	const release = async (): Promise<void> => {
		if (released) return;
		released = true;
		try {
			const current = readOwner(filePath);
			if (current?.pid === pid) rmSync(filePath, { force: true });
		} catch {
			/* ignore */
		}
	};
	return { status: "acquired", handle: { owner, release, update } };
}

export function readGatewayOwner(dir: string): GatewayOwner | undefined {
	return readOwner(join(dir, "gateway.json"));
}

export function gatewayLockPath(dir: string): string {
	return join(dir, "gateway.json");
}
