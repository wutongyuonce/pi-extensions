import test from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildDaemonCommand,
	checkUninstallCondition,
	cleanupStateDir,
	cleanupStateDirIfUninstalled,
	extensionStillRegistered,
	readLiveGatewayOwner,
	shellQuote,
	spawnDaemon,
	startUninstallWatch,
	stopDaemon,
} from "../../../src/host/daemon-host.ts";
import { acquireGatewayLock } from "../../../src/host/gateway-lock.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "fb-daemon-"));
}

test("shellQuote wraps and escapes single quotes", () => {
	assert.equal(shellQuote("pi"), "'pi'");
	assert.equal(shellQuote("/path/with space"), "'/path/with space'");
	assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("buildDaemonCommand constructs the headless rpc invocation", () => {
	const cmd = buildDaemonCommand({
		extensionPath: "/abs/ext/index.ts",
		lockDir: "/tmp/x",
		logPath: "/tmp/x.log",
		cwd: "/work",
		piBin: "/usr/local/bin/pi",
	});
	assert.ok(
		cmd.startsWith("{ tail -f /dev/null & echo $! > "),
		"管道保活 stdin + tail pid 落盘（回归修复：后台 & 使 pi stdin=/dev/null 立即 EOF → session_shutdown）",
	);
	assert.ok(
		cmd.includes("| exec "),
		"pi stdin 必须来自 tail 管道（保活，防 RPC 模式立即退出）",
	);
	assert.ok(cmd.includes("daemon-tail.pid"), cmd);
	assert.ok(cmd.includes("exec "));
	assert.ok(cmd.includes("'--mode' 'rpc'"), cmd);
	assert.ok(cmd.includes("'--no-builtin-tools'"), cmd);
	assert.ok(cmd.includes("'-e' '/abs/ext/index.ts'"), cmd);
	assert.ok(cmd.includes("'/usr/local/bin/pi'"), cmd);
});

test("readLiveGatewayOwner: 活 owner 返回；僵尸 owner 清理锁并返回 undefined", () => {
	const dir = tempDir();
	try {
		const lockPath = join(dir, "gateway.json");
		// 僵尸 owner：pid 不可能存活 → 锁被清掉，返回 undefined
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999_999_999, startedAt: 1, status: "connected" }),
		);
		assert.equal(readLiveGatewayOwner(dir), undefined);
		assert.equal(existsSync(lockPath), false, "僵尸锁被清理");

		// 活 owner（本进程 pid）→ 返回 owner，锁保留
		const lock = acquireGatewayLock(dir);
		assert.equal(lock.status, "acquired");
		const live = readLiveGatewayOwner(dir);
		assert.ok(live, "活 owner 被识别");
		assert.equal(live!.pid, process.pid);
		assert.equal(existsSync(lockPath), true, "活锁不被清理");
		void lock.handle?.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnDaemon 忽略僵尸锁并正常启动（机器重启残留不误判 busy）", async () => {
	const dir = tempDir();
	try {
		// 残留僵尸锁（模拟机器重启后 gateway.json 未清理）
		writeFileSync(
			join(dir, "gateway.json"),
			JSON.stringify({ pid: 999_999_999, startedAt: 1, status: "connected" }),
		);
		// fake "pi" shim：写自己的 gateway 锁后常驻（同现有 started 测试）
		const shim = join(dir, "pi");
		writeFileSync(
			shim,
			[
				"#!/bin/bash",
				"exec node -e '" +
					'const fs=require("fs");' +
					'fs.writeFileSync(process.env.LOCK,JSON.stringify({pid:process.pid,startedAt:Date.now(),status:"connected"}));' +
					'process.on("SIGTERM",()=>process.exit(0));' +
					"setInterval(()=>{},1000)'",
			].join("\n"),
		);
		chmodSync(shim, 0o755);
		const result = await spawnDaemon(
			{
				extensionPath: "/irrelevant.ts",
				lockDir: dir,
				logPath: join(dir, "daemon.log"),
				cwd: "/",
				piBin: shim,
				env: { LOCK: join(dir, "gateway.json") },
				waitForOwnerMs: 4000,
			},
			false,
		);
		assert.equal(result.status, "started", "僵尸锁必须被忽略，daemon 正常启动");
		assert.ok(result.owner, "owner reported");
		// 清理
		try {
			process.kill(result.owner!.pid, "SIGTERM");
		} catch {
			/* ignore */
		}
		try {
			process.kill(result.owner!.pid, "SIGKILL");
		} catch {
			/* ignore */
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnDaemon with takeover kills the old owner and spawns", async () => {
	const dir = tempDir();
	try {
		const { spawn } = await import("node:child_process");
		const oldOwner = spawn("sleep", ["30"], {
			detached: true,
			stdio: "ignore",
		});
		oldOwner.unref();
		const lock = acquireGatewayLock(dir, { pid: oldOwner.pid! });
		assert.equal(lock.status, "acquired");

		const result = await spawnDaemon(
			{
				extensionPath: "/nonexistent-extension-path.ts",
				lockDir: dir,
				logPath: join(dir, "daemon.log"),
				cwd: "/",
				waitForOwnerMs: 300,
			},
			true,
		);
		assert.equal(
			result.status,
			"busy",
			"no owner registers with a bad extension path",
		);
		// The old owner was killed by the takeover.
		let alive = true;
		try {
			process.kill(oldOwner.pid!, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, "old daemon should be terminated");
		try {
			process.kill(oldOwner.pid!, "SIGTERM");
		} catch {
			/* already dead */
		}
		void lock.handle?.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stopDaemon signals the owner pid and returns true", async () => {
	const dir = tempDir();
	try {
		// Spawn a real short-lived child as a fake daemon owner.
		const { spawn } = await import("node:child_process");
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		child.unref();
		const lock = acquireGatewayLock(dir, { pid: child.pid! });
		assert.equal(lock.status, "acquired");
		await new Promise((r) => setTimeout(r, 100));
		const stopped = await stopDaemon(dir);
		assert.equal(stopped, true);
		await new Promise((r) => setTimeout(r, 200));
		// Child should be dead now.
		let alive = true;
		try {
			process.kill(child.pid!, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, "daemon child should be terminated");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stopDaemon returns false when nobody owns the gateway", async () => {
	const dir = tempDir();
	try {
		assert.equal(await stopDaemon(dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stopDaemon escalates to SIGKILL when the owner ignores SIGTERM", async () => {
	const dir = tempDir();
	try {
		const { spawn } = await import("node:child_process");
		// A child that explicitly ignores SIGTERM — proves the SIGKILL fallback.
		const child = spawn(
			process.execPath,
			["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
		const lock = acquireGatewayLock(dir, { pid: child.pid! });
		assert.equal(lock.status, "acquired");
		const stopped = await stopDaemon(dir);
		assert.equal(stopped, true);
		// Give the escalation window time to elapse, then the child must be gone.
		await new Promise((r) => setTimeout(r, 1600));
		let alive = true;
		try {
			process.kill(child.pid!, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, "SIGTERM-ignoring daemon must be SIGKILLed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnDaemon reports started when a new live owner registers (daemon pid != wrapper pid)", async () => {
	const dir = tempDir();
	try {
		const { writeFileSync, chmodSync } = await import("node:fs");
		// A fake "pi" that writes gateway.json with its OWN pid then stays alive.
		// The real daemon runs via `tail -f /dev/null | exec pi …`, so the pi
		// process pid never equals the spawned bash wrapper pid — the fixed
		// spawnDaemon must treat ANY new live owner as success (bug 2026-08-07).
		const shim = join(dir, "pi");
		writeFileSync(
			shim,
			[
				"#!/bin/bash",
				"exec node -e '" +
					'const fs=require("fs");' +
					'fs.writeFileSync(process.env.LOCK,JSON.stringify({pid:process.pid,startedAt:Date.now(),status:"connected"}));' +
					'process.on("SIGTERM",()=>process.exit(0));' +
					"setInterval(()=>{},1000)'",
			].join("\n"),
		);
		chmodSync(shim, 0o755);
		const result = await spawnDaemon(
			{
				extensionPath: "/irrelevant.ts",
				lockDir: dir,
				logPath: join(dir, "daemon.log"),
				cwd: "/",
				piBin: shim,
				env: { LOCK: join(dir, "gateway.json") },
				waitForOwnerMs: 4000,
			},
			false,
		);
		assert.equal(
			result.status,
			"started",
			"new live owner must be reported started",
		);
		assert.ok(result.owner, "owner reported");
		assert.equal(
			result.pid,
			result.owner!.pid,
			"returned pid is the real daemon pid, not the bash wrapper pid",
		);
		let alive = true;
		try {
			process.kill(result.owner!.pid, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, true, "registered owner is a live process");
		// Cleanup: kill the fake daemon (node) and the wrapper chain.
		try {
			process.kill(result.owner!.pid, "SIGTERM");
		} catch {
			/* ignore */
		}
		try {
			process.kill(result.pid!, "SIGTERM");
		} catch {
			/* ignore */
		}
		try {
			process.kill(result.owner!.pid, "SIGKILL");
		} catch {
			/* ignore */
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extensionStillRegistered: 本地路径源解析正确", () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-reg-"));
	try {
		const settings = join(dir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ packages: ["./ext", "npm:other-pkg"] }),
		);
		const ext = join(dir, "ext");
		const entry = join(ext, "src", "index.ts");
		assert.equal(
			extensionStillRegistered(entry, [settings]),
			true,
			"本地源内入口已注册",
		);
		const outside = join(dir, "elsewhere", "index.ts");
		assert.equal(
			extensionStillRegistered(outside, [settings]),
			false,
			"源外入口未注册",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extensionStillRegistered: npm 源解析到 npm/node_modules 内", () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-reg-"));
	try {
		const settings = join(dir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ packages: ["npm:pi-feishu-link"] }),
		);
		const entry = join(
			homedir(),
			".pi",
			"agent",
			"npm",
			"node_modules",
			"pi-feishu-link",
			"src",
			"index.ts",
		);
		assert.equal(extensionStillRegistered(entry, [settings]), true);
		assert.equal(
			extensionStillRegistered(join(dir, "x.ts"), [settings]),
			false,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("checkUninstallCondition: 入口文件被删 → 退出；无设置文件 → 保守存活", () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-reg-"));
	try {
		const missing = join(dir, "gone", "index.ts");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: [] }));
		assert.equal(
			checkUninstallCondition(missing, [settings]),
			false,
			"入口已删除 → 退出",
		);
		// 入口存在但设置文件存在且不含本扩展 → 退出
		const entry = join(dir, "ext", "index.ts");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "", "utf8");
		assert.equal(
			checkUninstallCondition(entry, [settings]),
			false,
			"设置存在但未注册 → 退出",
		);
		// 无任何设置文件 → 保守存活（可能未经过 pi install）
		assert.equal(checkUninstallCondition(entry, []), true);
		assert.equal(
			checkUninstallCondition(entry, [join(dir, "no-such-settings.json")]),
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cleanupStateDir: 递归删除状态目录且幂等", () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-clean-"));
	try {
		const stateDir = join(dir, "state");
		mkdirSync(join(stateDir, "outbox"), { recursive: true });
		writeFileSync(join(stateDir, "config.json"), "{}");
		writeFileSync(join(stateDir, "outbox", "m1.json"), "{}");
		cleanupStateDir(stateDir);
		assert.equal(existsSync(stateDir), false, "整个状态目录被删除");
		// 幂等：目录不存在时再次清理不抛错
		cleanupStateDir(stateDir);
		assert.equal(existsSync(stateDir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cleanupStateDirIfUninstalled: 仍注册 → 不清理；已卸载 → 清理且幂等", () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-cu-"));
	try {
		const entry = join(dir, "ext", "index.ts");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "", "utf8");
		const stateDir = join(dir, "state");
		const settings = join(dir, "settings.json");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "config.json"), "{}");

		// settings 仍注册本扩展 → 不清理（防误删：git 操作/临时抖动不得删配置）
		writeFileSync(settings, JSON.stringify({ packages: ["./ext"] }));
		assert.equal(
			cleanupStateDirIfUninstalled({
				entryPath: entry,
				stateDir,
				settingsFiles: [settings],
			}),
			false,
			"仍注册 → 返回 false",
		);
		assert.equal(existsSync(join(stateDir, "config.json")), true, "配置保留");

		// 注册被移除 → 判定已卸载 → 清理
		writeFileSync(settings, JSON.stringify({ packages: [] }));
		assert.equal(
			cleanupStateDirIfUninstalled({
				entryPath: entry,
				stateDir,
				settingsFiles: [settings],
			}),
			true,
			"已卸载 → 返回 true",
		);
		assert.equal(existsSync(stateDir), false, "状态目录被清理");

		// 状态目录已不存在 → 幂等返回 true
		assert.equal(
			cleanupStateDirIfUninstalled({
				entryPath: entry,
				stateDir,
				settingsFiles: [settings],
			}),
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("startUninstallWatch: 检测到卸载 → 触发 onExit 并可停止", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-watch-"));
	try {
		let exits = 0;
		const stop = startUninstallWatch({
			entryPath: join(dir, "gone", "index.ts"), // 不存在 → 立即判定退出
			settingsFiles: [],
			intervalMs: 20,
			onExit: () => {
				exits += 1;
			},
		});
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(exits, 1, "onExit 触发一次");
		stop();
		const before = exits;
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(exits, before, "stop 后不再触发");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
