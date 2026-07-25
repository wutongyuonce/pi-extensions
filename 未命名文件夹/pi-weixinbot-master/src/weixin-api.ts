/**
 * 微信 API 调用模块
 * 参考: https://github.com/Tencent/openclaw-weixin
 */

import crypto from "node:crypto";
import type {
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetConfigResp,
  SendTypingReq,
  BaseInfo,
} from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

interface ApiErrorInfo {
  code: string;
  message: string;
  errcode?: number;
  errmsg?: string;
}

function parseApiError(response: any, httpStatus: number, rawText: string): ApiErrorInfo {
  // 优先尝试从 JSON body 中解析 errcode/errmsg
  let errcode: number | undefined;
  let errmsg: string | undefined;

  if (response && typeof response === "object") {
    errcode = response.errcode ?? response.ret;
    errmsg = response.errmsg;
  }

  // 尝试从原始文本中提取 errcode/errmsg
  if (errcode === undefined) {
    const errcodeMatch = rawText.match(/"errcode"\s*:\s*(-?\d+)/);
    if (errcodeMatch) errcode = parseInt(errcodeMatch[1], 10);
  }
  if (errmsg === undefined) {
    const errmsgMatch = rawText.match(/"errmsg"\s*:\s*"([^"]+)"/);
    if (errmsgMatch) errmsg = errmsgMatch[1];
  }

  const code = errcode !== undefined ? String(errcode) : String(httpStatus);
  const message = errmsg || rawText.slice(0, 200) || `HTTP ${httpStatus}`;

  return { code, message, errcode, errmsg };
}

class ApiError extends Error {
  code: string;
  errcode?: number;
  errmsg?: string;

  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = "ApiError";
    this.code = info.code;
    this.errcode = info.errcode;
    this.errmsg = info.errmsg;
  }

  get display(): string {
    return `错误码 ${this.code}：${this.message}`;
  }
}

// 常量
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;
const DEFAULT_API_TIMEOUT_MS = 15000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10000;

// 版本信息
const CHANNEL_VERSION = "1.0.0";
const ILINK_APP_ID = "";

/**
 * 构建请求基础信息
 */
function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

/**
 * 确保 URL 末尾有斜杠
 */
function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * 生成随机微信 UIN
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/**
 * 构建通用请求头
 */
function buildCommonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

/**
 * 构建带认证的请求头
 */
function buildAuthHeaders(token?: string): Record<string, string> {
  const headers = buildCommonHeaders();
  headers["AuthorizationType"] = "ilink_bot_token";
  if (token?.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }
  return headers;
}

/**
 * 发送 POST 请求
 */
async function postRequest(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const headers = buildAuthHeaders(params.token);
  headers["Content-Length"] = String(Buffer.byteLength(params.body, "utf-8"));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    if (!res.ok) {
      let json: any;
      try { json = JSON.parse(text); } catch { json = {}; }
      throw new ApiError(parseApiError(json, res.status, text));
    }
    return text;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * 发送 GET 请求
 */
async function getRequest(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const headers = buildCommonHeaders();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    if (!res.ok) {
      let json: any;
      try { json = JSON.parse(text); } catch { json = {}; }
      throw new ApiError(parseApiError(json, res.status, text));
    }
    return text;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * 长轮询获取新消息
 */
export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  get_updates_buf?: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;

  try {
    const rawText = await postRequest({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    // 超时是正常的，返回空响应让调用方重试
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: params.get_updates_buf,
      };
    }
    throw err;
  }
}

/**
 * 发送文本消息
 */
export async function sendMessage(params: {
  baseUrl: string;
  token?: string;
  to: string;
  text: string;
  clientId: string;
  contextToken?: string;
}): Promise<void> {
  await postRequest({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: params.clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: params.text
          ? [{ type: 1, text_item: { text: params.text } }]
          : [],
        context_token: params.contextToken ?? undefined,
      },
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
  });
}

/**
 * 获取上传 URL
 */
export async function getUploadUrl(params: {
  baseUrl: string;
  token?: string;
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}): Promise<GetUploadUrlResp> {
  const rawText = await postRequest({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
  });
  return JSON.parse(rawText) as GetUploadUrlResp;
}

/**
 * 获取配置（包含 typing_ticket）
 */
export async function getConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  const rawText = await postRequest({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
  });
  return JSON.parse(rawText) as GetConfigResp;
}

/**
 * 发送打字状态
 */
export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  typingTicket: string;
  status: number;
}): Promise<void> {
  await postRequest({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
  });
}

/**
 * 获取二维码
 */
export async function getQRCode(botType: string = "3"): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
  const rawText = await getRequest({
    baseUrl: FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: 30000,
  });
  return JSON.parse(rawText);
}

/**
 * 查询二维码状态
 */
export async function getQRCodeStatus(qrcode: string, baseUrl: string = "https://ilinkai.weixin.qq.com"): Promise<{
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}> {
  const rawText = await getRequest({
    baseUrl,
    endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    timeoutMs: 35000,
  });
  return JSON.parse(rawText);
}

// 导出错误类型供外部使用
export { ApiError };
