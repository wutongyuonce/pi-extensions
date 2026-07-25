/**
 * Session 排他锁管理器
 * 确保同一时间只有一个 pi session 可以连接微信
 */

import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { getStateDir } from "./weixin-auth.ts";

// 锁文件路径
function getLockFilePath(): string {
  return join(getStateDir(), "session.lock");
}

// 锁数据结构
interface LockData {
  pid: number;
  sessionId: string;
  timestamp: number;      // 创建时间
  lastHeartbeat: number;  // 最后心跳时间
  accountId?: string;     // 当前连接的微信账户
}

// 锁配置
const LOCK_HEARTBEAT_INTERVAL_MS = 10000;  // 心跳间隔：10秒
const LOCK_TIMEOUT_MS = 30000;              // 锁超时：30秒

let heartbeatTimer: NodeJS.Timeout | null = null;
let currentSessionId: string | null = null;

/**
 * 检查进程是否存在（跨平台）
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Node.js 的 process.kill(0) 可以检查进程是否存在
    // 不会实际发送信号，只是检查权限和进程存在性
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取锁文件
 */
async function readLockFile(): Promise<LockData | null> {
  try {
    const content = await readFile(getLockFilePath(), "utf-8");
    return JSON.parse(content) as LockData;
  } catch {
    return null;
  }
}

/**
 * 写入锁文件
 */
async function writeLockFile(data: LockData): Promise<void> {
  const lockPath = getLockFilePath();
  await writeFile(lockPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * 删除锁文件
 */
async function removeLockFile(): Promise<void> {
  try {
    await unlink(getLockFilePath());
  } catch {
    // 忽略删除失败（可能已被其他进程删除）
  }
}

/**
 * 尝试获取锁
 * @param sessionId 当前 session 的 ID
 * @returns 锁信息（成功）或 null（失败）
 */
export async function acquireLock(sessionId: string, accountId?: string): Promise<{ success: boolean; message: string; existingSession?: LockData }> {
  const now = Date.now();
  const existingLock = await readLockFile();

  // 检查是否存在有效锁
  if (existingLock) {
    const isOwner = existingLock.sessionId === sessionId;
    const pidRunning = isProcessRunning(existingLock.pid);
    const notExpired = now - existingLock.lastHeartbeat < LOCK_TIMEOUT_MS;

    // 如果锁属于自己，更新心跳即可
    if (isOwner) {
      existingLock.lastHeartbeat = now;
      existingLock.timestamp = now;
      if (accountId) existingLock.accountId = accountId;
      await writeLockFile(existingLock);
      currentSessionId = sessionId;
      startHeartbeat(sessionId, accountId);
      return { success: true, message: "锁已更新（当前 session）" };
    }

    // 如果锁属于其他进程且有效，获取失败
    if (pidRunning && notExpired) {
      return {
        success: false,
        message: `微信已被其他 session 占用 (PID: ${existingLock.pid}, Session: ${existingLock.sessionId.slice(0, 8)}...)`,
        existingSession: existingLock,
      };
    }

    // 锁已失效（进程不存在或心跳超时），强制抢占
    console.log(`[weixinbot-lock] 检测到失效锁，强制抢占 (PID: ${existingLock.pid} 不存在或已超时)`);
  }

  // 创建新锁
  const newLock: LockData = {
    pid: process.pid,
    sessionId,
    timestamp: now,
    lastHeartbeat: now,
    accountId,
  };

  await writeLockFile(newLock);
  currentSessionId = sessionId;
  startHeartbeat(sessionId, accountId);

  return { success: true, message: "成功获取锁" };
}

/**
 * 释放锁
 */
export async function releaseLock(sessionId?: string): Promise<void> {
  // 停止心跳
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // 检查当前锁是否属于自己
  const existingLock = await readLockFile();
  if (existingLock && (existingLock.sessionId === sessionId || existingLock.sessionId === currentSessionId)) {
    await removeLockFile();
    console.log(`[weixinbot-lock] 锁已释放 (Session: ${existingLock.sessionId.slice(0, 8)}...)`);
  }

  currentSessionId = null;
}

/**
 * 启动心跳定时器
 */
function startHeartbeat(sessionId: string, accountId?: string): void {
  // 清除旧定时器
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  // 启动新定时器
  heartbeatTimer = setInterval(async () => {
    try {
      const lock = await readLockFile();
      if (lock && lock.sessionId === sessionId) {
        lock.lastHeartbeat = Date.now();
        if (accountId) lock.accountId = accountId;
        await writeLockFile(lock);
      }
    } catch (err) {
      console.error(`[weixinbot-lock] 心跳更新失败:`, err);
    }
  }, LOCK_HEARTBEAT_INTERVAL_MS);

  // 确保进程退出时清理
  process.once("exit", () => {
    releaseLock(sessionId);
  });

  process.once("SIGINT", () => {
    releaseLock(sessionId);
    process.exit(0);
  });

  process.once("SIGTERM", () => {
    releaseLock(sessionId);
    process.exit(0);
  });
}

/**
 * 检查锁状态
 */
export async function checkLockStatus(): Promise<{
  locked: boolean;
  ownedByMe: boolean;
  session?: LockData;
}> {
  const lock = await readLockFile();

  if (!lock) {
    return { locked: false, ownedByMe: false };
  }

  const pidRunning = isProcessRunning(lock.pid);
  const notExpired = Date.now() - lock.lastHeartbeat < LOCK_TIMEOUT_MS;
  const isValid = pidRunning && notExpired;
  const ownedByMe = lock.sessionId === currentSessionId;

  return {
    locked: isValid,
    ownedByMe,
    session: lock,
  };
}

/**
 * 强制释放锁（谨慎使用）
 */
export async function forceReleaseLock(): Promise<boolean> {
  try {
    await removeLockFile();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    currentSessionId = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取当前 session ID
 */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}
