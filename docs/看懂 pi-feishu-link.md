# 看懂 pi-feishu-link：TUI 只负责拉起，真正听飞书的是另一条 daemon

> 本文面向已经会用 Pi、知道「扩展会在宿主里注册命令和钩子」的读者。重点不是飞书开放平台的字段清单，而是讲清：扫码之后谁在听 WebSocket、关 TUI 为什么消息还在、发出去的卡片丢了会不会补、飞书里敲 `/model` 走的是哪一层。
>
> **本文定位：中项目、二次开发深度。** 稳定认知放在进程边界、网关锁、入站权威源、出站 outbox 上；表情名、卡片 schema、节流毫秒数属于易变细节。包版本 `0.2.3` 仍在修「发了没回复」类回归，**以 `src/index.ts` 与 `src/host/daemon-host.ts` 为准**，不要只信 README 的「流式输出」四个字（默认是关的）。
>
> 源码基线：本仓库 `pi-feishu-link`，包版本 `0.2.3`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交同 HEAD。上游：[amlyczz/pi-feishu-link](https://github.com/amlyczz/pi-feishu-link)。入口：`package.json` → `pi.extensions = ["./src/index.ts"]`。

## 1. TLDR：它不是「在当前 Pi 窗口里接飞书」

飞书用户发一句话，到 Pi 真正跑一轮 Agent，中间隔着**两个 Pi 进程**：

```text
飞书客户端
    │  im.message.receive_v1（平台推事件，不保证重放）
    ▼
daemon 进程（pi --mode rpc，stdin 被 tail 管道吊着）
    │  持有 gateway.json 锁 = 全机唯一 WebSocket 主人
    │  入站去重 → 群触发策略 → 命令分流 或 对话 FIFO
    │  createAgentSession.prompt()   ← 对话 Agent 在 daemon 进程内，不是再开一个 pi
    │  最终回复进 outbox（落盘 JSONL，至少一次）
    ▼
飞书 REST 发消息 / 更卡片
```

TUI 这边默认**不连飞书**：

```text
你打开的 pi TUI
    │  session_start + autoStart=true
    │  发现没有活的 gateway owner
    ▼
spawn 一个 detached daemon（环境变量 PI_FEISHU_LINK_DAEMON=1）
    │  自己只读 gateway.json，刷新状态行
    ▼
你 Ctrl-C 掉 TUI
    │  session_shutdown → stopBridge()，但本进程不是 owner → 不杀 daemon
    ▼
飞书桥还在
```

所以它**不是**：

- 不是当前 TUI 会话的一个 webhook 插件。关窗口不等于关桥。
- 不是飞书官方的「消息保证送达」。WebSocket 断了平台**不重放**事件；漏收要靠自己扫历史补。
- 不是常驻系统服务 / launchd。没有人在开机时拉它，是下一次有 Pi TUI（或你手动 `/feishu start`）才 spawn。
- 不是「流式卡片 = 权威回复」。Live channel 是易失的；权威在 outbox 的 finalize。
- 不是飞书侧再实现一套 Pi。`/model` `/compact` 是适配器调 `AgentSession` API；未知 `/xxx` 原样丢进 `prompt()`。

正面定义：**一台机器一个飞书网关进程，凭据和队列在 `~/.pi/agent/feishu-link/`，TUI 只当遥控器。**

## 2. 为什么要把网关从 TUI 里拆出去

正例：你在终端里用 Pi 写代码，同时用飞书给家里的机器人发「看看今天下没下班」。TUI 退出、笔记本合盖再打开，你希望飞书这边还在。所以网关必须活在 **detached 子进程**里，stdin 还不能 EOF——RPC 模式一旦 stdin 断，就会 `session_shutdown`，桥跟着死。`daemon-host.ts` 用 `tail -f /dev/null | exec pi …` 吊住 stdin，就是为这个。

反例：把 WebSocket 开在当前 TUI 里。多开两个 Pi 窗口 = 两个连接打到同一个飞书应用，租户连接配额（`exceed_conn_limit`）被打爆，之后谁都连不上。所以必须有 **全机一把锁**（`gateway.json`，`wx` 独占创建），失败者立即退出，不许挂着空转。

四行职责：

| 谁 | 管什么 |
| -- | ------ |
| TUI 进程 | `/feishu setup\|start\|stop\|takeover`，spawn/杀 daemon，状态行只读 |
| daemon 进程 | 唯一 WS、入站管道、对话 session、outbox 排水 |
| 飞书开放平台 | 事件推送与 REST；**不保证断线重放** |
| `~/.pi/agent/feishu-link/` | 凭据、锁、去重、路由、出站队列；这是桥的本地权威 |

## 3. 先看整体架构，不急着看类名

文档视角（扩展自己的分层注释，`src/index.ts` 文件头）：

```text
L0  进程与锁     daemon 拉起 / gateway.json / 卸载扫 settings
L1  传输         WS + REST 封装、静默重建、配额熔断、漏消息补偿
L2  会话         每个飞书会话一把 FIFO、权限卡、工具进度转发
L3  出站         live 流式（可丢）+ outbox（不可丢）+ 路由表
L4  呈现         卡片 / 富文本
应用层           入站编排、命令三级分流、诊断包
```

进程真相比这张图狠：L0–L4 **只存在于拿到锁的那一个进程**。TUI 加载了同一份 `index.ts`，但 `session_start` 看见 `PI_FEISHU_LINK_DAEMON !== "1"` 就只走 spawn，不 `startBridge()`。两份代码、两种角色，不是两套实现。

状态目录（可用 `PI_FEISHU_LINK_HOME` 改根，默认 `~/.pi/agent/feishu-link/`，创建权限 `0700`）：

```text
feishu-link/
├─ config.json            凭据 + 策略（权威：这个应用是谁、群怎么触发）
├─ runtime-overrides.json 热改（/feishu config、飞书里 /feishu-config）
├─ gateway.json           谁持有 WS（pid / starting|connected|stopping）
├─ daemon-tail.pid        保活管道的 tail pid，杀 daemon 时一起收
├─ daemon.log             daemon stdout/stderr
├─ routes.json            对话 key → chatId/thread（出站找得到人）
├─ dedupe.jsonl           已见 message_id
├─ status.json            派生状态（给 /status 看，不是权威）
├─ conn-history.jsonl     连接失败窗口（配额熔断跨进程生效）
├─ outbox/                JSONL 段文件，崩溃可重建内存队列
└─ logs/
```

权威源要分清：

- **用户意图**：飞书消息本身（平台推过来的那一条）。
- **应用身份与策略**：`config.json`（setup 写入 appId/appSecret；空名单 = 不限制）。
- **出站该不该再发**：outbox 的 `dedupeKey` + 状态机，不是卡片有没有刷出来。
- **这条对话回哪**：`routes.json`，不是当前 TUI 的 cwd。

## 4. 运行形态：三个进程角色，只有一个握着插座

### 4.1 工厂加载了 ≠ 桥在跑

`export default function feishuBridgeExtension(pi)` 每次 Pi 加载扩展都会进。但第一行就有递归守卫：`PI_FEISHU_LINK_CHILD=1` 时直接 return。源码里给这个变量赋值的**只有测试**；生产对话 session 是 daemon 进程内的 `createAgentSession`，不会再走一遍扩展工厂。守卫是防「再 spawn 一个带全套扩展的 pi」的预留，不是当前主路径。

然后分叉：

| 角色 | 怎么进来 | 做什么 | 退出时 |
| ---- | -------- | ------ | ------ |
| TUI | 普通 `pi`，无 `DAEMON_ENV` | 未配置就横幅；配置了且 `autoStart`（默认 true）就 spawn daemon | `stopBridge()`，因不是 owner，**不断**飞书 |
| daemon | `spawn({env: PI_FEISHU_LINK_DAEMON=1})` | `startBridge()`：抢锁、连 WS、开 outbox | 抢锁失败立刻 `process.exit`；卸载监控到扩展没了会删整个状态目录 |
| 对话 Agent | daemon 里 `createAgentSession` | 真正跑模型、工具、写代码 | 空闲超时 / 驻留上限 / `/stop` dispose |

daemon 的命令行（`buildDaemonCommand`）是刻意削瘦的：

```text
pi --mode rpc
   --no-extensions --no-skills --no-prompt-templates --no-themes
   --no-context-files --no-builtin-tools
   -e <本扩展入口>
```

`--no-extensions` 再 `-e` 自己：宿主会话只加载这一份桥，避免 TUI 那堆扩展在无头进程里再打一遍。`--no-builtin-tools` 削的是 **RPC 宿主会话**，不是对话 Agent——对话 session 由 SDK 自己建，工具集跟这一行无关。

stdin 必须一直开着。曾经有人把 `tail` 改成后台、stdin 接 `/dev/null`，RPC 立刻 EOF → `session_shutdown` → 桥 50ms 自杀。这是 0.2.2 的回归根因，现命令又变回管道保活。

### 4.2 锁：活 pid 才算主人

`gateway.json` 用 `writeFileSync(..., {flag:"wx"})` 创建。文件在且 pid 还活着 → 别人只能报 busy，或 `/feishu takeover` 先 SIGKILL 再抢。pid 已死的僵尸锁会被 `readLiveGatewayOwner` 清掉——机器重启后如果只读文件不探活，autoStart 会以为 daemon 还在，于是「发飞书没回复」。

文档视角「扩展管理连接」；进程真相是 **文件锁选出来的那一个 pid** 管理连接。TUI 的状态行只是读这把锁。

### 4.3 谁拉起、谁不拉起

没有 systemd unit。触发 spawn 的只有：

1. TUI `session_start` 且 `autoStart` 且没有活 owner；
2. TUI 命令 `/feishu start` / `restart` / `takeover`。

`/feishu stop` 杀 owner、清 tail，**保留** `config.json`。`pi remove` 后 daemon 扫 settings，发现扩展入口没了，才删整个状态目录（含 appSecret）。卸载 ≠ 立刻断连：如果 daemon 没扫到，旧进程会继续占着 WS，TUI 会提示 takeover。

## 5. 纵向链路一：飞书来了一句话

语义层（同步/异步标在节点上）：

```text
1. 平台推事件          异步，飞书 → daemon WS
2. 传输层规范化        同步，SDK 原始包 → FeishuInboundMessage
3. 入站去重            同步，message_id 进 dedupe.jsonl；见过就丢
4. 群触发闸门          同步，p2p 必过；群按 open / mention / 关键词 / 回机器人
5. 命令三级分流        同步判定，异步回复
6. 对话 FIFO           异步排队；忙时只进队，不并行 prompt
7. Agent 回合          异步，session.prompt(..., streamingBehavior:"followUp")
8. 出站落地            异步，最终文本进 outbox；表情 DONE 是 best-effort
```

完成 ≠ 就绪：

- WS `connected` ≠ 能收到消息。扫码创建的应用默认只订卡片回调，**必须**在 `registerApp` 的 addons 里订 `im.message.receive_v1`，否则「连上了但群里说话没反应」。
- `handleInbound` 返回 ≠ 用户看见回复。FIFO 可能还在排；outbox 可能还在 backoff。
- 打上随机「已收到」表情 ≠ 模型开始干活。表情是入站确认，DONE 才是回合结束。
- 空输出（例如某些 goal 激活回合）**故意不打 DONE、不发卡片**。

群策略（`group-trigger.ts`，纯函数）：`open` 群内每条都接；`mention` 要 @机器人；关键词是大小写不敏感子串；`groupAlsoOnReply` 允许「回机器人的那条」也触发。白名单 `allowUsers` / `allowChats` 为空 = 不限制。第一个 **p2p** 发送者会被写成 `ownerOpenId`（自动管理员），但一旦你配了 `allowUsers`，所有权就不再「谁先说话谁当家」。

对话 session 的工作区跟 TUI 当前目录无关：`ConversationManager` 按 conversation key 懒创建，有驻留上限和空闲回收。`prompt` 必须带 `streamingBehavior: "followUp"`，否则上一轮还在流式时群里连发会抛 `Agent is already processing`。

附件走单独管道（张数/总字节有上限，默认 4 个 / 30MB 量级，数字易变）。图片会变成 `prompt()` 的 images 参数，不是「文件名丢进文本完事」。

## 6. 纵向链路二：回复怎么回到飞书（两条通道）

```text
模型开始吐字
    │
    ├─ live channel（内存、合并、节流）──► 改卡片
    │     可丢。默认 forward.streaming.enabled = false
    │
    └─ 回合结束
          有实际文本 → outbox.enqueue(final) → REST 发送/更新
          空文本     → 静默
```

**Live channel 不是正确性路径。** 注释写得很冲：dropped patch is fine，finalize 会对齐。默认还关着。README 把「流式输出」写成特性，二次开发请看 `DEFAULT_CONFIG.forward.streaming`。

Outbox 才是 R1：

- 目录里 JSONL 段文件，按行追加；启动时重建内存。
- **按 lane 并行排水**：`laneKey = conversationKey`，同一对话严格 FIFO，对话之间不互相头阻塞。
- `dedupeKey` 命中视为已入队，再 enqueue 直接返回旧信封 → at-least-once 在业务上接近 effectively-once。
- `RetryableError`（超时、5xx、若干业务码）指数退避，**不放弃**，只堵住这一 lane。
- `FatalDeliveryError`（确定的 4xx / 非瞬时业务码）标 failed，不再试。
- pending 有硬顶、目录体积有顶；满了 `EnqueueRejectedError`，这条回复从桥的角度就是没出去。

路由（`routes.json`）：入站时把 `p2p:<openId>` / `group:<chatId>` 绑到 chatId 和可选 thread。定时任务另有 job 路由，带 TTL。发得出去的前提是「这条对话曾经进来过」——桥冷启动后没有任何路由，不会主动找人聊天。

## 7. 纵向链路三：飞书里敲一条斜杠命令

三级分流（`command-router.ts`），**没有管理员门禁、没有命令黑名单**：

```text
/xxx
 ├─ 桥自己的：help / status / stop / workspace / doctor / feishu-config
 │     立刻回卡片或停当前任务，不进模型
 ├─ Pi 内置：model / thinking / compact / new / resume / login / …
 │     适配器调 AgentSession API；列表类会进入「待选」60s
 ├─ 调度：loop / remind / schedule / unschedule
 │     探测到 my-pi-scheduler 才原样 prompt；否则回安装说明
 └─ 其余（/goal、/skill:、未知）
       原样 handleConversationMessage → 当普通 prompt
```

TUI 里另有一套 `/feishu …`（`pi.registerCommand("feishu")`）：setup 出二维码、start/stop/restart/status/doctor/takeover/config。这是遥控器，不是飞书消息。

setup 的坑已经写进 `auth-setup.ts`：`registerApp` 默认**不订**消息事件。addons 必须带上消息订阅 + 发读权限；事后还有 `verifyEventSubscription` 自检。扫码成功 ≠ 能聊天。

权限桥（默认 `relaxed`）：绝大多数工具直接放行；命中破坏性黑名单才弹审批卡，管理员点了才跑，5 分钟没人点 = 拒绝。`strict` 才恢复「不安全就问」。群聊的一次批准**不**写入 session 记忆，避免「有人批过 rm 之后群里谁都能 rm」。

唯一显式注册的工具是 `feishu_send_local_file`，挂在扩展工厂的 `pi.registerTool` 上。对话 Agent 的 `createAgentSession` **没有**把这个工具当参数传进去；execute 自己也写了「请在飞书里说发送文件，由 daemon 处理」。不要假定对话模型一定能直接调到它。

## 8. 边界、概念区分、常见误区

**daemon 活着 ≠ 对话 session 活着。** 网关进程常驻（只要没人 stop、没被卸载清理）；每个飞书会话的 AgentSession 有 `maxResident` / `idleDisposeMs`，闲了就 dispose。下次消息会懒创建，聊天记录在 session 文件里，不在 WS 连接里。

**去重存过 ≠ 这轮处理过。** `dedupe.jsonl` 只保证同一 `message_id` 不进管道两次。补偿扫描会 `skipDedupe` 重放「去重里没有」的历史；已经 admit 但 FIFO 里失败的，不会因为去重而自动重跑。

**补偿跑完 ≠ 断线期间每条都在。** 重连后飞书不重放。补偿按已知 chat 拉最近几分钟、每群有条数上限，还要「读聊天记录」权限。未知的群、超窗口的消息，就是丢了。

**owner 不是飞书应用所有者。** 是桥自己记的第一个 p2p 用户。应用的真正主人在飞书后台。

**TUI `/stop` 和飞书 `/stop` 不是同一个。** 飞书 `/stop` 只 dispose **当前 conversation key** 的任务；TUI `/feishu stop` 拆掉整个网关。

误区 1：「我开着 Pi 窗口，飞书才会回。」——默认相反，窗口只负责保证有一个 daemon。

误区 2：「README 写了流式，所以卡片会一个字一个字跳。」——默认 `streaming.enabled=false`。

误区 3：「多开几个 TUI 能多连几个机器人。」——同一 `rootDir` 一把锁；要多实例得换 `PI_FEISHU_LINK_HOME` **和**另一套 app 凭据。

误区 4：「`PI_FEISHU_LINK_CHILD` 会在每个对话 session 里被设上。」——生产路径没设。对话 session 根本不重新加载这个扩展。

## 9. 失败形态：现象对链路

| 你看见的 | 先查哪一层 |
| -------- | ---------- |
| 扫码成功，飞书里说话没反应 | 事件订阅（addons / doctor）；群策略是不是 mention 却没 @ |
| 状态行说已启动，其实没回 | `readLiveGatewayOwner`：是不是僵尸锁导致没 spawn；`daemon.log` 是不是 50ms 退出 |
| 偶尔能连、然后所有窗口都 exceed_conn_limit | 多 TUI 并发 spawn；配额熔断（`conn-history.jsonl`）在挡重试，不要对着 `/feishu restart` 猛砸 |
| 回了「处理失败：…」 | Agent 回合抛错，outbox 已经把错误文本发出去了——桥是通的 |
| 卡片闪一下没了 / 按钮点了原卡消失 | 0.2.3 已改成「点按钮发新消息、回调不替换原卡」；旧卡片 schema 2.0 不吃 `action` 容器 |
| 工具要批，卡发出去没人理，五分钟后工具失败 | 权限桥超时自动 deny，不是模型挂了 |
| 卸载了还在回飞书 | daemon 没扫到 settings；TUI 会提示旧 daemon，需要 `/feishu stop` 或 takeover |
| `/loop` 回安装说明 | 调度器是可选依赖，没装就到此为止，不是命令坏了 |

`/feishu doctor`（飞书里旧名 `/support` 仍兼容）打诊断包：配置会 mask secret、hash 用户 id。不要把 `daemon.log` 原样贴到群里。

## 10. 总结：五件能独立核对的事 + 一条主线

1. 扩展工厂在 TUI 和 daemon 都会跑；**只有 `DAEMON_ENV=1` 且抢到 `gateway.json` 的进程才 `startBridge()`。**
2. daemon 是 `pi --mode rpc` + 管道保活 stdin 的 detached 进程，不是系统服务；TUI 退出默认不杀它。
3. 入站权威是飞书事件；本地 `dedupe.jsonl` 只去重。断线漏消息靠补偿扫历史，有窗口、有上限、要权限。
4. 出站权威是 outbox JSONL（至少一次、按对话分 lane）；live channel 可丢，默认关闭。
5. 飞书斜杠命令三级分流，无管理员门禁；TUI `/feishu` 是遥控器，和飞书 `/status` 不是同一张表。

```text
TUI ──spawn──► daemon(rpc) ──锁──► 唯一 WS
                    │
                    ├─ 入站：去重 → 闸门 → 命令|FIFO → AgentSession
                    └─ 出站：live（可丢） / outbox（可重建）
```

## 11. 深入通道：源码阅读顺序

1. `package.json` + `src/index.ts` 文件头与 `session_start` 分叉（约 846 行起）。看了能懂「同一份工厂、两种角色」。
2. `src/host/daemon-host.ts`、`src/host/gateway-lock.ts`。看了能懂 stdin 保活、wx 锁、僵尸 pid、takeover。
3. `src/common/config.ts`、`src/common/types.ts`。看了能懂状态目录和默认策略（含 streaming 默认关）。
4. `src/inbound/transport.ts`、`connection-supervisor.ts`、`missed-compensation.ts`、`group-trigger.ts`。看了能懂「连上 ≠ 能聊、重连 ≠ 补齐」。
5. `src/application/message-handler.ts`、`src/sessions/conversation-manager.ts`、`pi-session-backend.ts`。看了能懂 FIFO、`followUp`、对话 session 在哪个进程。
6. `src/outbound/outbox.ts`、`live-channel.ts`、`outbound-router.ts`。看了能懂两条出站通道和 lane。
7. `src/application/command-router.ts`、`src/commands/pi-command-adapter.ts`。看了能懂飞书里的 `/` 为什么有的立刻回、有的进模型。
8. `src/host/auth-setup.ts`、`src/sessions/permission-bridge.ts`、`src/common/quota-governor.ts`。看了能懂扫码、审批卡、连接风暴熔断。
9. `test/unit/host/daemon-host.test.ts`、`test/unit/outbound/outbox.test.ts`、`test/integration/extension-load.test.ts`。行为合同在测试里，比注释硬。

本地冒烟：`pi install <本目录>`，TUI 里 `/feishu setup` 扫码，确认 `~/.pi/agent/feishu-link/gateway.json` 的 pid 不是 TUI 的 pid；关掉 TUI，飞书再发一句，还应有回复。`ps` 里应能看到 `pi --mode rpc` 和一条 `tail -f /dev/null`。

## 参考资料

- [pi-feishu-link README](https://github.com/amlyczz/pi-feishu-link)
- 仓库内设计稿：`pi-feishu-link/.spec/2026-08-08-2000-pi-feishu-link综合设计spec.md`
- [飞书开放平台 · 事件订阅](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- 前作参考（本包从零重写，只借鉴思路）：[AX1202/pi-feishu-lark](https://github.com/AX1202/pi-feishu-lark)、[yangtuooc/pi-feishu-lark](https://github.com/yangtuooc/pi-feishu-lark)
- 可选调度依赖：[@ineersa/my-pi-scheduler](https://github.com/ineersa/my-pi-scheduler)
