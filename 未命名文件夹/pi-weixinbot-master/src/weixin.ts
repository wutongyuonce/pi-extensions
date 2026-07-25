/**
 * pi-weixinbot
 * 
 * 微信机器人 extension for pi
 * 支持扫码登录和消息收发
 * 
 * 参考: https://github.com/Tencent/openclaw-weixin
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

import {
  getUpdates,
  sendMessage as sendWeixinMessage,
  DEFAULT_BASE_URL,
} from "./weixin-api.ts";
import type { WeixinMessage, WeixinAccountData } from "./types.ts";
import {
  fullQRLogin,
  getLoggedInAccounts,
  logoutAccount,
  getStateDir,
} from "./weixin-auth.ts";
import {
  acquireLock,
  releaseLock,
  checkLockStatus,
  forceReleaseLock,
} from "./lock-manager.ts";

// ============================================================================
// 类型定义
// ============================================================================

interface Session {
  frame: any;
  streamId: string;
  userId: string;
  chatId: string;
  timestamp: number;
  accountId: string;
  contextToken?: string;
}

interface PendingMessage {
  reqId: string;
  type: string;
  text: string;
  accountId: string;
  userId: string;
  contextToken?: string;
}

// ============================================================================
// 工具函数
// ============================================================================

function generateClientId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `pi-weixin-${timestamp}-${random}`;
}

function getSessionId(): string {
  if (process.env.PI_SESSION_ID) return process.env.PI_SESSION_ID;
  if (process.env.PI_INSTANCE_ID) return process.env.PI_INSTANCE_ID;
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `sess-${timestamp}-${random}`;
}

function getConfigPath(): string {
  return join(getStateDir(), "config.json");
}

// ============================================================================
// 消息处理
// ============================================================================

/**
 * 从消息中提取文本内容
 */
function extractTextBody(itemList?: WeixinMessage["item_list"]): string {
  if (!itemList?.length) return "";

  for (const item of itemList) {
    // 文本消息
    if (item.type === 1 && item.text_item?.text != null) {
      let text = String(item.text_item.text);

      // 处理引用消息
      const ref = item.ref_msg;
      if (ref?.message_item) {
        const refType = ref.message_item.type;
        // 引用的是媒体消息，只取当前文本
        if (refType === 2 || refType === 3 || refType === 4 || refType === 5) {
          // 媒体类型
        }
        // 引用的是文本，添加引用前缀
        else if (refType === 1 && ref.message_item.text_item?.text) {
          text = `[引用: ${ref.message_item.text_item.text}]\n${text}`;
        }
      }

      return text;
    }

    // 语音转文字
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }

  return "";
}

/**
 * 过滤 Markdown 特殊字符（用于发送到微信）
 */
function filterMarkdown(text: string): string {
  // 移除可能干扰微信显示的 Markdown 格式
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")  // 粗体
    .replace(/\*(.*?)\*/g, "$1")      // 斜体
    .replace(/`(.*?)`/g, "$1")        // 行内代码
    .replace(/```[\s\S]*?```/g, (match) => {
      // 代码块，保留内容
      return match.replace(/```\w*\n?/g, "").trim();
    })
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")  // 链接
    .replace(/^#+\s*/gm, "")          // 标题标记
    .replace(/^[-*]\s+/gm, "• ")      // 列表标记
    .replace(/^\d+\.\s+/gm, "");      // 有序列表
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 保存 pi 实例供内部函数使用
  const piInstance = pi;
  // 初始化
  const SESSION_ID = getSessionId();


  // 全局状态
  let currentAccount: (WeixinAccountData & { accountId: string }) | null = null;
  let isConnected = false;
  let monitorAbortController: AbortController | null = null;
  let loginInProgress = false;

  const pendingMessages: PendingMessage[] = [];
  let isProcessing = false;
  let currentReqId: string | null = null;
  // 使用 Map 跟踪多个待回复的用户，避免被覆盖
  const replyToMap = new Map<string, { userId: string; contextToken?: string }>();

  // ============================================================================
  // 状态栏更新
  // ============================================================================

  async function updateStatus(ctx: any) {
    if (!ctx?.ui?.setStatus) return;

    // 未登录且非登录中时，不显示状态栏
    if (!currentAccount && !loginInProgress) {
      ctx.ui.setStatus("weixinbot", "");
      return;
    }

    let status = "[微信]";

    if (loginInProgress) {
      status += " ⏳ 登录中...";
    } else if (isConnected && currentAccount) {
      const accountShort = currentAccount.accountId.slice(0, 8);
      const pending = pendingMessages.length;
      status += ` ✅ 已连接 | ${accountShort}... | 待处理:${pending}`;
    } else {
      status += " ❌ 已断开";
    }

    // 添加锁状态
    const lockStatus = await checkLockStatus();
    if (lockStatus.locked) {
      if (lockStatus.ownedByMe) {
        status += " | 🔒";
      } else {
        status += " | ❌ 被占用";
      }
    }

    ctx.ui.setStatus("weixinbot", status);
  }

  // ============================================================================
  // 配置管理
  // ============================================================================

  async function loadConfig(): Promise<{ lastAccountId?: string }> {
    try {
      const data = await readFile(getConfigPath(), "utf8");
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  async function saveConfig(cfg: { lastAccountId?: string }) {
    await mkdir(dirname(getConfigPath()), { recursive: true });
    await writeFile(getConfigPath(), JSON.stringify(cfg, null, "\t") + "\n");
  }

  // ============================================================================
  // 消息队列处理
  // ============================================================================

  async function processMessageQueue(ctx?: any) {
    if (isProcessing || pendingMessages.length === 0) return;
    isProcessing = true;

    // 更新状态栏显示待处理消息数
    if (ctx) await updateStatus(ctx);

    const message = pendingMessages[0];
    if (!message) {
      isProcessing = false;
      return;
    }

    // 检查账户是否匹配
    if (message.accountId !== currentAccount?.accountId) {
      console.log(`[weixinbot] 账户不匹配`);
      pendingMessages.shift();
      isProcessing = false;
      processMessageQueue(ctx);
      return;
    }

    currentReqId = message.reqId;
    // 将用户信息存入 Map，而不是单个变量
    replyToMap.set(message.reqId, { userId: message.userId, contextToken: message.contextToken });

    try {
      await pi.sendUserMessage([{ type: "text", text: message.text }], { deliverAs: "followUp" });
      console.log(`[weixinbot] → AI`);
    } catch (err: any) {
      console.error(`[weixinbot] → AI 失败: ${err.message}`);

      replyToMap.delete(message.reqId);
      pendingMessages.shift(); // 发送失败，从队列移除
      isProcessing = false;
      processMessageQueue(ctx); // 继续处理下一条
    }

    // 注意：不要立即从队列移除，等 AI 回复完成后再移除
    // pendingMessages.shift(); // 移到 message_end 处理中
    isProcessing = false;
    
    // 继续处理队列中的下一条消息（如果有）
    // 但如果上一条还在等待回复，这里可能会有问题
    // 暂时只处理一条消息，等回复完成后再处理下一条
    // processMessageQueue();
  }

  // ============================================================================
  // 微信消息监控
  // ============================================================================

  async function startMonitor(piInstance?: ExtensionAPI) {
    if (!currentAccount?.token || !currentAccount.accountId) {
      console.log(`[weixinbot] 无法启动监控：未登录`);
      return;
    }

    if (monitorAbortController) {
      monitorAbortController.abort();
    }

    monitorAbortController = new AbortController();
    const abortSignal = monitorAbortController.signal;

    let getUpdatesBuf = "";

    console.log(`[weixinbot] 启动监控`);

    async function poll() {
      if (abortSignal.aborted) return;

      try {
        const resp = await getUpdates({
          baseUrl: currentAccount!.baseUrl ?? DEFAULT_BASE_URL,
          token: currentAccount!.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: 35000,
        });

        if (typeof resp.ret === "number" && resp.ret !== 0) {
          console.log(`[weixinbot] getUpdates: ret=${resp.ret}, errcode=${resp.errcode}`);
          if (resp.errcode === -14) {
            // Session 过期
            console.log(`[weixinbot] ⚠️ Session 过期`);
            isConnected = false;
            // 发送通知给用户
            if (piInstance) {
              piInstance.sendMessage({
                customType: "weixinbot-status",
                content: "⚠️ 微信 Session 已过期，请使用 /weixin-login 重新登录",
                display: true,
              }, { deliverAs: "steer", triggerTurn: false });
            }
            return;
          }
        }

        // 更新 sync buf
        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
        }

        // 处理消息
        if (resp.msgs && resp.msgs.length > 0) {
          for (const msg of resp.msgs) {
            // 忽略自己发送的消息（message_type === 2 是 BOT）
            if (msg.message_type === 2) continue;

            const fromUserId = msg.from_user_id ?? "";
            if (!fromUserId) continue;

            const textBody = extractTextBody(msg.item_list);
            if (!textBody && (!msg.item_list || msg.item_list.length === 0)) continue;

            // 构建消息文本
            let messageText = textBody;

            // 检查是否有媒体附件
            const hasImage = msg.item_list?.some(i => i.type === 2);
            const hasVideo = msg.item_list?.some(i => i.type === 5);
            const hasFile = msg.item_list?.some(i => i.type === 4);
            const hasVoice = msg.item_list?.some(i => i.type === 3 && !i.voice_item?.text);

            if (hasImage) messageText += "\n[收到图片消息]";
            if (hasVideo) messageText += "\n[收到视频消息]";
            if (hasFile) messageText += "\n[收到文件消息]";
            if (hasVoice && !textBody) messageText = "[收到语音消息，需微信端查看]";

            // 发送消息到 AI
            const reqId = generateClientId();
            pendingMessages.push({
              reqId,
              type: "text",
              text: messageText,
              accountId: currentAccount!.accountId,
              userId: fromUserId,
              contextToken: msg.context_token,
            });

          }

          // 处理消息队列
          processMessageQueue();
        }
      } catch (err) {
        console.error(`[weixinbot] getUpdates 异常: ${err}`);

      }

      // 继续轮询
      if (!abortSignal.aborted) {
        setTimeout(poll, 100);
      }
    }

    poll();
  }

  function stopMonitor() {
    if (monitorAbortController) {
      monitorAbortController.abort();
      monitorAbortController = null;
      console.log(`[weixinbot] 监控停止`);
    }
  }

  // ============================================================================
  // 发送消息
  // ============================================================================

  async function sendTextMessage(to: string, text: string, contextToken?: string): Promise<void> {
    if (!currentAccount?.token) {
      throw new Error("未登录微信，请先登录");
    }

    const filteredText = filterMarkdown(text);

    await sendWeixinMessage({
      baseUrl: currentAccount.baseUrl ?? DEFAULT_BASE_URL,
      token: currentAccount.token,
      to,
      text: filteredText,
      clientId: generateClientId(),
      contextToken,
    });
  }

  // ============================================================================
  // 登录/登出
  // ============================================================================

  async function performLogin(ctx?: any): Promise<boolean> {
    try {
      // 先检查是否已有保存的账户（token）
      const config = await loadConfig();
      const accounts = getLoggedInAccounts();

      // 如果有已保存的账户，尝试直接加载（无需扫码）
      if (config.lastAccountId) {
        const savedAccount = accounts.find(a => a.accountId === config.lastAccountId);

        if (savedAccount?.token) {

          // 尝试获取排他锁
          const lockResult = await acquireLock(SESSION_ID, savedAccount.accountId);
          if (!lockResult.success) {
            console.log(`[weixinbot] 无法获取锁`);
            if (ctx?.hasUI) {
              await ctx.ui.notify(`[weixinbot] ${lockResult.message}`, "error");
            }
            await updateStatus(ctx);
            return false;
          }

          currentAccount = savedAccount;
          isConnected = true;

          // 启动消息监控
          startMonitor(pi);


          if (ctx?.hasUI) {
            await ctx.ui.notify(`[weixinbot] 微信已连接（从缓存加载）`, "info");
          }

          await updateStatus(ctx);
          return true;
        }
      }

      // 没有保存的账户，走二维码登录流程
      loginInProgress = true;
      await updateStatus(ctx);

      const result = await fullQRLogin({
        onStatus: (status, message) => {
        },
        onQRCode: (url) => {
          // 可以在终端显示二维码
        },
      });

      loginInProgress = false;

      if (result.connected && result.accountId) {
        // 加载保存的账户
        const accounts = getLoggedInAccounts();
        currentAccount = accounts.find(a => a.accountId === result.accountId) ?? null;

        if (currentAccount) {
          // 尝试获取排他锁
          const lockResult = await acquireLock(SESSION_ID, result.accountId);
          if (!lockResult.success) {
            console.log(`[weixinbot] 无法获取锁`);
            if (ctx?.hasUI) {
              await ctx.ui.notify(`[weixinbot] ${lockResult.message}`, "error");
            }
            // 虽然登录成功，但不启动监控，因为锁被其他 session 持有
            currentAccount = null;
            await updateStatus(ctx);
            return false;
          }

          await saveConfig({ lastAccountId: result.accountId });
          isConnected = true;

          // 启动消息监控
          startMonitor(pi);

          await updateStatus(ctx);
          return true;
        }
      }

      console.log(`[weixinbot] 登录失败`);
      await updateStatus(ctx);
      return false;
    } catch (err) {
      loginInProgress = false;
      console.error(`[weixinbot] 登录异常: ${err}`);

      await updateStatus(ctx);
      return false;
    }
  }

  async function performLogout(accountId: string, ctx?: any): Promise<void> {
    logoutAccount(accountId);
    if (currentAccount?.accountId === accountId) {
      stopMonitor();
      await releaseLock(SESSION_ID);
      currentAccount = null;
      isConnected = false;
    }
    console.log(`[weixinbot] 已退出登录`);
    await updateStatus(ctx);
  }

  // ============================================================================
  // 注册工具
  // ============================================================================

  // 发送消息工具
  pi.registerTool({
    name: "weixin_send",
    label: "Weixin Send",
    description: "发送文本消息给微信用户",
    parameters: Type.Object({
      text: Type.String({ description: "要发送的文本内容" }),
      to: Type.Optional(Type.String({ description: "接收者用户 ID（可选，默认发送给当前对话用户）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        // 确定接收者
        let toUserId = params.to;

        if (!toUserId) {
          // 使用当前会话的用户 ID
          const currentMsg = pendingMessages.find(m => m.reqId === currentReqId);
          if (currentMsg) {
            toUserId = currentMsg.userId;
          }
        }

        if (!toUserId) {
          return {
            content: [{ type: "text", text: "错误：无法确定接收者，请指定 'to' 参数" }],
            details: {},
            isError: true,
          };
        }

        const currentMsg = pendingMessages.find(m => m.userId === toUserId);

        await sendTextMessage(
          toUserId,
          params.text,
          currentMsg?.contextToken
        );

        return {
          content: [{ type: "text", text: `消息已发送给 ${toUserId.slice(0, 8)}...` }],
          details: {},
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `发送失败: ${err.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // 获取登录状态
  pi.registerTool({
    name: "weixin_status",
    label: "Weixin Status",
    description: "获取当前微信连接状态",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const accounts = getLoggedInAccounts();
      const lockStatus = await checkLockStatus();

      // 更新状态栏
      await updateStatus(ctx);

      let statusText = `[weixinbot] 状态:\n`;
      statusText += `- 已登录账户: ${accounts.length}\n`;

      for (const acc of accounts) {
        const isCurrent = currentAccount?.accountId === acc.accountId;
        statusText += `\n  - ${acc.accountId?.slice(0, 12)}... ${isCurrent ? "(当前)" : ""}`;
        if (acc.name) statusText += ` (${acc.name})`;
      }

      statusText += `\n\n- 当前连接: ${isConnected ? "已连接" : "未连接"}`;

      // 添加锁状态信息
      if (lockStatus.locked) {
        if (lockStatus.ownedByMe) {
          statusText += `\n- 独占锁: 🔒 当前 session 持有`;
        } else {
          const otherSession = lockStatus.session?.sessionId?.slice(0, 8);
          const otherPid = lockStatus.session?.pid;
          statusText += `\n- 独占锁: ❌ 被其他 session 占用 (PID: ${otherPid}, Session: ${otherSession}...)`;
        }
      } else {
        statusText += `\n- 独占锁: 🔓 未锁定`;
      }

      return {
        content: [{ type: "text", text: statusText }],
        details: { lockStatus },
      };
    },
  });

  // 强制释放锁工具（用于异常情况）
  pi.registerTool({
    name: "weixin_force_unlock",
    label: "Weixin Force Unlock",
    description: "强制释放微信 session 锁（谨慎使用！会中断其他 session 的连接）",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const lockStatus = await checkLockStatus();

      if (!lockStatus.locked) {
        return {
          content: [{ type: "text", text: "当前没有锁，无需释放" }],
          details: {},
        };
      }

      if (lockStatus.ownedByMe) {
        await releaseLock(SESSION_ID);
        return {
          content: [{ type: "text", text: "✅ 已释放当前 session 持有的锁" }],
          details: {},
        };
      }

      // 强制释放其他 session 的锁
      const otherSession = lockStatus.session?.sessionId?.slice(0, 8);
      const otherPid = lockStatus.session?.pid;

      const success = await forceReleaseLock();
      if (success) {
        return {
          content: [{ type: "text", text: `✅ 已强制释放 session ${otherSession}... (PID: ${otherPid}) 的锁` }],
          details: {},
        };
      } else {
        return {
          content: [{ type: "text", text: "❌ 强制释放锁失败" }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // 微信登录
  pi.registerTool({
    name: "weixin_login",
    label: "Weixin Login",
    description: "通过扫码登录微信（请使用手机微信扫描二维码）",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // 检查是否有二维码显示能力
      if (ctx.hasUI) {
        await ctx.ui.notify("正在启动微信登录...", "info");
      }

      const success = await performLogin(ctx);

      if (success) {
        if (ctx.hasUI) {
          await ctx.ui.notify("微信登录成功！", "info");
        }
        return {
          content: [{ type: "text", text: "✅ 微信登录成功！消息监控已启动。" }],
          details: {},
        };
      } else {
        if (ctx.hasUI) {
          await ctx.ui.notify("微信登录失败", "error");
        }
        return {
          content: [{ type: "text", text: "❌ 微信登录失败，请重试。" }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // 微信登出
  pi.registerTool({
    name: "weixin_logout",
    label: "Weixin Logout",
    description: "退出当前微信登录",
    parameters: Type.Object({
      accountId: Type.Optional(Type.String({ description: "要登出的账户 ID（可选，默认登出当前账户）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const accountId = params.accountId ?? currentAccount?.accountId;

      if (!accountId) {
        return {
          content: [{ type: "text", text: "没有登录的账户" }],
          details: {},
        };
      }

      await performLogout(accountId, ctx);

      return {
        content: [{ type: "text", text: `已退出账户 ${accountId.slice(0, 12)}...` }],
        details: {},
      };
    },
  });

  // ============================================================================
  // 注册命令
  // ============================================================================

  // 微信登录命令
  pi.registerCommand("weixin-login", {
    description: "微信扫码登录",
    handler: async (_args, ctx) => {
      await ctx.ui.notify("正在启动微信登录...", "info");
      const success = await performLogin(ctx);
      if (success) {
        await ctx.ui.notify("微信登录成功！", "info");
      } else {
        await ctx.ui.notify("微信登录失败", "error");
      }
    },
  });

  // 微信状态命令
  pi.registerCommand("weixin-status", {
    description: "查看微信连接状态",
    handler: async (_args, ctx) => {
      const accounts = getLoggedInAccounts();
      const lockStatus = await checkLockStatus();
      let status = `已登录账户: ${accounts.length}\n`;
      for (const acc of accounts) {
        const isCurrent = currentAccount?.accountId === acc.accountId;
        status += `- ${acc.accountId?.slice(0, 12)}... ${isCurrent ? "(当前)" : ""}\n`;
      }
      status += `当前连接: ${isConnected ? "已连接" : "未连接"}\n`;

      // 添加锁状态
      if (lockStatus.locked) {
        if (lockStatus.ownedByMe) {
          status += `独占锁: 🔒 当前 session 持有`;
        } else {
          status += `独占锁: ❌ 被其他 session 占用`;
        }
      } else {
        status += `独占锁: 🔓 未锁定`;
      }

      await ctx.ui.notify(status, "info");
      await updateStatus(ctx);
    },
  });

  // ============================================================================
  // 流处理 - 捕获 AI 回复并发送回微信
  // ============================================================================

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    // 只处理助手消息（AI 回复）
    if (message.role !== "assistant") {
      return;
    }

    // 未登录时不处理消息
    if (!isConnected || !currentAccount) {
      return;
    }

    // 从队列中取出第一条消息（最早发送给 AI 的）
    const pendingMsg = pendingMessages[0];
    if (!pendingMsg) {
      return;
    }

    // 获取对应的用户信息
    const replyTo = replyToMap.get(pendingMsg.reqId);
    if (!replyTo) {
      pendingMessages.shift(); // 清理队列
      replyToMap.delete(pendingMsg.reqId);
      await updateStatus(ctx); // 更新状态栏
      return;
    }

    // 提取文本内容
    let replyText = "";
    for (const content of message.content) {
      if (content.type === "text") {
        replyText += content.text;
      }
    }

    if (!replyText.trim()) {
      pendingMessages.shift(); // 清理队列
      replyToMap.delete(pendingMsg.reqId);
      await updateStatus(ctx); // 更新状态栏
      return;
    }

    const { userId, contextToken } = replyTo;

    try {
      await sendTextMessage(userId, replyText.trim(), contextToken);
      console.log(`[weixinbot] → 已发送`);
    } catch (err: any) {
      console.error(`[weixinbot] → 发送失败: ${err.message}`);
    }

    // 清理
    pendingMessages.shift();
    replyToMap.delete(pendingMsg.reqId);

    // 更新状态栏显示待处理消息数
    await updateStatus(ctx);

    // 继续处理队列中的下一条消息
    processMessageQueue();
  });

  // ============================================================================
  // 事件处理
  // ============================================================================

  // 会话启动时仅初始化状态（不自动连接微信）
  pi.on("session_start", async (_event, ctx) => {
    // 初始化状态栏
    await updateStatus(ctx);
  });

  // 会话关闭时停止监控并释放锁
  pi.on("session_shutdown", async (_event, _ctx) => {
    stopMonitor();
    await releaseLock(SESSION_ID);
  });

  // ============================================================================
  // 启动提示
  // ============================================================================

}

// 导出工具函数供外部使用
export { getLoggedInAccounts, fullQRLogin } from "./weixin-auth.ts";
export { sendMessage as sendWeixinMessage, DEFAULT_BASE_URL } from "./weixin-api.ts";
