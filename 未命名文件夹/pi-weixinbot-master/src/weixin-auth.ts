/**
 * 微信登录认证模块
 * 参考: https://github.com/Tencent/openclaw-weixin
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { getQRCode, getQRCodeStatus, DEFAULT_BASE_URL } from "./weixin-api.ts";
import type { QRCodeResponse, QRStatusResponse, LoginResult, WeixinAccountData } from "./types.ts";

// 常量
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const ACTIVE_LOGIN_TTL_MS = 5 * 60 * 1000; // 5 分钟

// 活跃登录会话
interface ActiveLogin {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  currentApiBaseUrl?: string;
  status?: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
}

const activeLogins = new Map<string, ActiveLogin>();

// ============================================================================
// 存储管理
// ============================================================================

export function getStateDir(): string {
  return path.join(homedir(), ".pi", "agent", "weixin");
}

function getAccountsDir(): string {
  return path.join(getStateDir(), "accounts");
}

function getAccountPath(accountId: string): string {
  return path.join(getAccountsDir(), `${accountId}.json`);
}

function getAccountsIndexPath(): string {
  return path.join(getStateDir(), "accounts.json");
}

/**
 * 加载账户数据
 */
export function loadAccount(accountId: string): WeixinAccountData | null {
  try {
    const filePath = getAccountPath(accountId);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 保存账户数据
 */
export function saveAccount(accountId: string, data: Partial<WeixinAccountData>): void {
  const dir = getAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadAccount(accountId) ?? {};

  const merged: WeixinAccountData = {
    ...existing,
    ...data,
    savedAt: new Date().toISOString(),
  };

  const filePath = getAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");

  // 设置文件权限为 600
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * 删除账户
 */
export function deleteAccount(accountId: string): void {
  const filePath = getAccountPath(accountId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

/**
 * 列出所有已注册的账户 ID
 */
export function listAccountIds(): string[] {
  try {
    const indexPath = getAccountsIndexPath();
    if (!fs.existsSync(indexPath)) return [];
    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * 注册账户 ID
 */
export function registerAccountId(accountId: string): void {
  const dir = getStateDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = listAccountIds();
  if (existing.includes(accountId)) return;

  const updated = [...existing, accountId];
  fs.writeFileSync(getAccountsIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * 取消注册账户 ID
 */
export function unregisterAccountId(accountId: string): void {
  const existing = listAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(getAccountsIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
  deleteAccount(accountId);
}

/**
 * 检查登录会话是否新鲜
 */
function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

/**
 * 清理过期的登录会话
 */
function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(id);
    }
  }
}

// ============================================================================
// 登录流程
// ============================================================================

export interface QRLoginStartResult {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
}

/**
 * 开始扫码登录 - 获取二维码
 */
export async function startQRLogin(opts?: {
  accountId?: string;
  force?: boolean;
}): Promise<QRLoginStartResult> {
  const sessionKey = opts?.accountId || randomUUID();

  purgeExpiredLogins();

  // 检查现有会话
  const existing = activeLogins.get(sessionKey);
  if (!opts?.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: "二维码已就绪，请使用微信扫描。",
      sessionKey,
    };
  }

  try {
    const qrResponse: QRCodeResponse = await getQRCode(DEFAULT_BOT_TYPE);

    const login: ActiveLogin = {
      sessionKey,
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    };

    activeLogins.set(sessionKey, login);

    return {
      qrcodeUrl: qrResponse.qrcode_img_content,
      message: "使用微信扫描以下二维码，以完成连接。",
      sessionKey,
    };
  } catch (err) {
    return {
      message: `获取二维码失败: ${String(err)}`,
      sessionKey,
    };
  }
}

const MAX_QR_REFRESH_COUNT = 3;

/**
 * 等待扫码登录完成
 */
export async function waitForQRLogin(opts: {
  sessionKey: string;
  timeoutMs?: number;
  onStatus?: (status: string, message?: string) => void;
}): Promise<LoginResult> {
  const callbacks = opts.onStatus ?? (() => {});

  let activeLogin = activeLogins.get(opts.sessionKey);

  if (!activeLogin) {
    callbacks("error", "当前没有进行中的登录，请先发起登录。");
    return {
      connected: false,
      message: "当前没有进行中的登录，请先发起登录。",
    };
  }

  if (!isLoginFresh(activeLogin)) {
    activeLogins.delete(opts.sessionKey);
    callbacks("expired", "二维码已过期，请重新生成。");
    return {
      connected: false,
      message: "二维码已过期，请重新生成。",
    };
  }

  const timeoutMs = Math.max(opts.timeoutMs ?? 480000, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  // 初始化轮询 URL
  activeLogin.currentApiBaseUrl = FIXED_BASE_URL;

  callbacks("waiting", "等待扫码...");

  while (Date.now() < deadline) {
    try {
      const currentBaseUrl = activeLogin.currentApiBaseUrl ?? FIXED_BASE_URL;
      const statusResponse: QRStatusResponse = await getQRCodeStatus(activeLogin.qrcode, currentBaseUrl);

      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case "wait":
          // 继续等待
          break;

        case "scaned":
          if (!scannedPrinted) {
            callbacks("scaned", "已扫码，请在微信确认登录");
            scannedPrinted = true;
          }
          break;

        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            activeLogins.delete(opts.sessionKey);
            callbacks("expired", "二维码多次过期，登录失败");
            return {
              connected: false,
              message: "登录超时：二维码多次过期，请重新开始登录流程。",
            };
          }

          callbacks("refreshing", `二维码已过期，正在刷新... (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`);

          try {
            const qrResponse = await getQRCode(DEFAULT_BOT_TYPE);
            activeLogin.qrcode = qrResponse.qrcode;
            activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
            activeLogin.startedAt = Date.now();
            scannedPrinted = false;
            callbacks("refreshed", "新二维码已生成，请重新扫描");
          } catch (refreshErr) {
            activeLogins.delete(opts.sessionKey);
            callbacks("error", `刷新二维码失败: ${String(refreshErr)}`);
            return {
              connected: false,
              message: `刷新二维码失败: ${String(refreshErr)}`,
            };
          }
          break;
        }

        case "scaned_but_redirect": {
          const redirectHost = statusResponse.redirect_host;
          if (redirectHost) {
            const newBaseUrl = `https://${redirectHost}`;
            activeLogin.currentApiBaseUrl = newBaseUrl;
            callbacks("redirect", `正在重定向到: ${redirectHost}`);
          }
          break;
        }

        case "confirmed": {
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(opts.sessionKey);
            callbacks("error", "登录失败：服务器未返回机器人 ID");
            return {
              connected: false,
              message: "登录失败：服务器未返回 ilink_bot_id。",
            };
          }

          activeLogins.delete(opts.sessionKey);

          const accountId = statusResponse.ilink_bot_id;
          saveAccount(accountId, {
            token: statusResponse.bot_token,
            baseUrl: statusResponse.baseurl ?? DEFAULT_BASE_URL,
            userId: statusResponse.ilink_user_id,
          });
          registerAccountId(accountId);

          callbacks("confirmed", "登录成功！");

          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "与微信连接成功！",
          };
        }
      }
    } catch (err) {
      callbacks("error", `轮询出错: ${String(err)}`);
      activeLogins.delete(opts.sessionKey);
      return {
        connected: false,
        message: `登录失败: ${String(err)}`,
      };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  activeLogins.delete(opts.sessionKey);
  callbacks("timeout", "登录超时");
  return {
    connected: false,
    message: "登录超时，请重试。",
  };
}

/**
 * 完整的扫码登录流程
 */
export async function fullQRLogin(opts?: {
  onStatus?: (status: string, message?: string) => void;
  onQRCode?: (url: string) => void;
}): Promise<LoginResult> {
  const callbacks = opts?.onStatus ?? (() => {});

  // 1. 获取二维码
  callbacks("start", "正在获取二维码...");
  const startResult = await startQRLogin();

  if (!startResult.qrcodeUrl) {
    return {
      connected: false,
      message: startResult.message,
    };
  }

  // 2. 返回二维码 URL（供外部显示）
  opts?.onQRCode?.(startResult.qrcodeUrl);
  callbacks("qr_ready", "二维码已生成，请在微信中扫描");

  // 3. 等待登录完成
  return await waitForQRLogin({
    sessionKey: startResult.sessionKey,
    timeoutMs: 480000,
    onStatus: callbacks,
  });
}

/**
 * 获取已登录账户列表
 */
export function getLoggedInAccounts(): Array<WeixinAccountData & { accountId: string }> {
  const ids = listAccountIds();
  const accounts: Array<WeixinAccountData & { accountId: string }> = [];

  for (const id of ids) {
    const data = loadAccount(id);
    if (data?.token) {
      accounts.push({ ...data, accountId: id });
    }
  }

  return accounts;
}

/**
 * 登出指定账户
 */
export function logoutAccount(accountId: string): void {
  unregisterAccountId(accountId);
}
