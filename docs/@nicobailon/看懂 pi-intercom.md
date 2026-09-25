# 看懂 pi-intercom：本机一对一传话，broker 只转发不记账

> 本文面向第一次接触 `pi-intercom`、但已经知道「Pi 是编码 Agent、扩展会往宿主里注册工具」的读者。重点不是罗列 socket 字段，而是讲清：它解决什么问题、消息实际在哪个进程里走、broker 交出去算不算对方已经读到、失败时会话历史会不会变成 inbox。
>
> **本文定位：中项目、二次开发深度。** 稳定认知放在职责边界与投递状态机上；别名文案、快捷键、ask 超时默认值属于易变细节。
>
> 源码基线：本仓库 `@nicobailon/pi-intercom`，包版本 `0.12.1`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13ed69a55f94889194018f652adf628ddc4b`（2026-09-03）。上游独立仓库：[nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom)。

## 1. TLDR：它做的事情可以压缩成一条投递链

`pi-intercom` 给同一台机器上的多个 Pi 会话做 **1:1 定向传话**（不是群聊房间）。人按 `Alt+M` / 跑 `/intercom`，或模型调 `intercom` 工具，消息都先到本机 broker，再被对方会话注入成一条可见消息。

```text
发送会话（Pi 进程 A）
  → 本机 IPC（Unix socket / Windows TCP 127.0.0.1）
  → broker 进程（按名字或 session id 找对端）
  → 接收会话（Pi 进程 B）
  → 注入：steer（只塞上下文）或 triggerTurn（立刻开一轮）
```

所以它不是：

- 不是跨机器消息总线。没有网络监听，没有云端中继。
- 不是 `pi-messenger` 那种共享聊天室。你必须点名接收方。
- 不是独立 inbox / 邮件系统。没有单独的 intercom 日志文件；发出去、收进来都写进 **Pi 自己的 session jsonl**。
- 不是「连上 broker = 对方模型已经开始干活」。socket 交出去只说明对端扩展进程收到了帧。

正面定义：它是 **本机会话目录 + 帧转发器**。目录由 broker 维护；是否开一轮、如何回复，由接收方扩展和 `inboundTrigger` 决定。

## 2. 为什么要单独做一对一，而不是共用一个房间

正例：一个终端在做调研，一个终端在改代码。调研会话要把「结论 + 关键文件路径」交给执行会话，而不想把两边的工具噪声搅在一起。这时要的是点名投递，不是广播。

反例：把所有 Pi 进程丢进同一个频道。执行会话会淹没在别的会话的闲聊里，模型分不清哪条是给自己的任务。

所以职责切开：

| 谁 | 管什么 | 不管什么 |
|---|---|---|
| 发送方扩展 | 选人、组消息、等投递回执、可选阻塞等回复 | 不保证对端已经注入、已经开 turn |
| broker | 在线目录、把帧送到对端或放进邮箱 | 不解释正文、不持久化对话、不跨机器 |
| 接收方扩展 | 渲染、按策略注入、回执 `injected` / `acknowledged` | 不替发送方决定要不要阻塞 |
| Pi session jsonl | 留下 `intercom_sent` / `intercom_message` 这类自定义条目 | 不是可检索的独立 inbox |

权威数据源要分清：

- **谁在线**：只信 broker 当前的连接表。没加载本扩展、没注册成功的 Pi 窗口不会出现。
- **消息正文**：信发送时那一帧。broker 不改写业务内容。
- **对方是否真的开了 turn**：信接收方的 `inboundTrigger` 和 `pi.sendMessage(..., { triggerTurn })`，不信 `delivered: true`。

## 3. 先看整体架构，不急着看类名

文档视角：

```text
接入层     Alt+M / /intercom / /alias / /intercom-id / intercom 工具 / contact_supervisor
   ↓
会话运行时  连 broker、心跳、重连、在线状态（idle / thinking / tool:xxx）
   ↓
投递层     send（可进邮箱） / ask（对端必须在线） / reply / cancel
   ↓
broker     目录、邮箱、回执、扩展总线（给别的扩展借用通道）
   ↓
接收注入   内联 UI + session 历史；steer 或 triggerTurn
```

进程真相：上面五层里，**只有 broker 是另一个进程**。每个 Pi 会话仍是自己的宿主进程；扩展代码跑在会话里。broker 不是常驻系统服务，也不是用户手动 `systemd` 起来的守护。

| 节点 | 载体 | 同步？ |
|---|---|---|
| 用户按快捷键 | 当前 Pi 进程的 TUI overlay | 同步等你选人、写完 |
| `intercom({action:"send"})` | 当前进程 → broker → 对端 | 等到 broker 回 `socket_delivered` 或 `queued` |
| `intercom({action:"ask"})` | 同上，但发送方工具调用阻塞 | 等到对端 `reply`，或超时 / 取消 |
| 对端注入 | 对端 Pi 进程的 `sendMessage` | 注入完成 ≠ 模型已经答完 |
| broker 空闲退出 | broker 进程自己的 5 秒定时器 | 异步；会话会自动再拉起 |

完成 ≠ 就绪的三处：

1. `delivered: true` 且 `delivery: "queued"`：对端当时不在线，信进了邮箱。对方以后重连才会看到。
2. `delivery: "socket_delivered"`：对端扩展进程拿到了帧。还没等于已经 `injected`，更不等于已经 `triggerTurn`。
3. 工具 `ask` 返回了回复文本：那是对端某次 `reply` 的结果。对端可能还在跑别的 turn。

## 4. 实际怎样运行：插件 + 按需拉起的本机 broker

运行形态一句话：**每个加载了本扩展的 Pi 会话，是客户端；broker 是本机单实例转发进程，第一次有人用才拉起，没人连了就退出。**

证据落在启动链上：

1. Pi 加载 `package.json` 里的 `pi.extensions: ["./index.ts"]`。
2. `session_start` 里，若 `config.enabled` 不为 false，扩展 `spawnBrokerIfNeeded()`，再作为客户端连上去注册自己。
3. Unix / macOS：监听 `~/.pi/agent/intercom/broker.sock`（`PI_CODING_AGENT_DIR` 可改根）。目录 `0700`，socket 文件 `0600`。
4. Windows：默认改走 `127.0.0.1` 的 TCP，端口写进运行时文件，连接还要带 `stateId`，避免随便一个本机进程连上。
5. 最后一个会话断开后，broker **约 5 秒**空闲就 `shutdown`。不是开机常驻。
6. 会话侧有存活探测：周期性发轻量 list，broker 不回就拆掉半开连接再重连。

配置文件在 `~/.pi/agent/intercom/config.json`（同样跟 agent 目录走）。解析失败时 **失败关闭**：入站自动开 turn 会落到 `inboundTrigger: "never"`，直到配置修好。这是安全默认，不是「坏配置=沿用上次内存值」。

`confirmSend` 默认 false：模型 `send` 不弹窗。打开后，有 UI 的会话会在非 reply 的出站前问人；无 UI 时直接 `blocked`（`confirmation_unavailable`），不会偷偷发出去。`replyHint` 控制注入文案里要不要附带一条「用 intercom reply」的提示，只影响提示词，不影响投递。列表旁的 `72% ctx (144k/200k)` 来自 `format-context.ts`：百分比未知（刚 compact）就留空，避免把过期数字画成真的。

`PI_INTERCOM_SCOPE_ID` 可以把不同 agent 目录 / 不同用户隔离成不同房间。没设时，同一 agent 目录下的会话共享一个 broker。

拉起 broker 不是「谁先 `spawn` 谁赢」。`broker.spawn.lock` 防止两个会话同时孵化；`broker.pid` 上的 `assertNoLiveBroker` 拒绝覆盖还活着的进程。锁文件里的 pid 已经死了、或锁超过约 10 秒，才当成陈旧锁丢掉。Windows TCP 监听端口为 0（内核分配），真正的 `host/port/stateId` 写进端口文件后客户端才连。

线上帧是 **4 字节大端长度 + JSON**，单帧上限 1 MiB。超长直接拆连接，避免把 broker 当成文件传输。心跳不是 ping 帧，是客户端周期性发轻量 `list`：broker 不回就认为半开，拆掉重连。

和「常驻 IM 服务」的差别：

```text
文档视角：本机有一个 intercom 服务
进程真相：有会话才有 broker；没会话就没有进程
           重启 broker 不丢「对话记录」——因为它本来就不存对话
           邮箱里未取的 send 最多留 24 小时
```

## 5. 人怎么发，模型怎么发，子代理怎么喊人

三条入口共用同一条 broker 通道，但阻塞语义不同。

**人驱动。** `/intercom` 或 `Alt+M` 打开会话列表 overlay，再打开 compose overlay。发出去后当前 session 记一条 `intercom_sent`。compose **不提供附件 UI**；协议里的 `file` / `snippet` / `context` 附件是给工具路径留的。

**模型驱动。** 工具名就叫 `intercom`，按 `action` 分支：

- `list` / `list-cwd`：问 broker 要当前目录。列表不是「这台机器上所有 Pi 进程」，只是 **已经注册成功的会话**。
- `send`：火即忘。对端离线可以进邮箱。若对端恰好只有一条未回复的 ask，这次 send 会被推断成答那条（带上 `replyTo`）。当前 turn 本身是被某条 ask 触发的，再 `send` 给别人会被拒绝——防止把「答监督者」误寄到同目录的另一个窗口。
- `ask`：阻塞等回复。对端不在线 **不会入队**，broker 直接失败（`E_TARGET_DISCONNECTED` 这一路）。
- `reply`：答一条还在等的 ask。`ReplyTracker` 按当前 turn 的来源、或显式 `replyTo` 对齐。
- `cancel`：发送方撤回还在邮箱里、或请求取消尚未完成的投递。

**子代理喊监督者。** 当 `pi-subagents` 给了子进程桥接元数据、且没有原生 supervisor channel 时，才会多注册一个 `contact_supervisor`。这不是通用 IM，是「被委派的子会话找不到人时的逃生口」。`need_decision` / `interview_request` 会等回复；`progress_update` 不等。

`/alias` 给当前会话起名，方便别人 `to: "planner"` 这种人话寻址。重名时要用 session id 前缀。`/intercom-id` 只是把稳定手递片段塞进编辑器，方便你复制到另一个窗口。

`list-cwd` 的「同一目录」不是字符串相等。`cwd.ts` 会 `resolve` + `realpath`，把尾斜杠、`.`/`..`、以及 macOS 上 `/tmp` 和 `/private/tmp` 这类符号链接收成同一个身份。否则两个窗口开在「看起来不一样、其实是同一个工作区」的路径上，会互相看不见。

列表上的 status（`idle` / `thinking` / `tool:xxx`）来自发送方扩展自己报的 presence：`agent_start`、`tool_execution_start/end`、`turn_end`、`model_select`。那是扩展视角的忙闲，不是操作系统的进程状态。上下文占用百分比也走同一条 presence，compaction 刚结束、下一条助手回复还没来时，这些字段可以暂时缺席。

## 6. 纵向链路一：一封 send 从按键走到对端屏幕

按语义切层，不按文件名切。

```text
1. 接入     人在 overlay 写完，或模型调用 send
2. 组帧     当前进程生成 message id，带上 from 的 cwd / 模型 / pid
3. 出门     IntercomClient 经 length-prefixed 帧写进 socket
4. 路由     broker 用名字或 id 找到对端；重名且都离线则拒绝模糊投递
5. 交割     在线 → socket_delivered；离线 send → queued（邮箱，24h）
6. 注入     对端 sendMessage(customType: intercom_message)
7. 是否开转  inboundTrigger + 这条是不是 reply 决定 triggerTurn 还是 steer
8. 回执     receiver_received → injected →（可选）acknowledged
```

第 5 步完成 ≠ 第 6 步完成。发送方工具在第 5 步就可以返回成功。对端当时可能正在跑别的工具，消息先排着。

`inboundTrigger`（易变，但语义稳定）三种：

- `always`：入站 broker 消息默认开 turn。出厂默认。
- `replies`：只有带着 `replyTo` 的才自动开转，减少「别人随手 send 就把我模型吵醒」。
- `never`：broker 入站不自动开转。本地进程内的子代理中继事件仍可以触发被点名的会话——那条路不经过 broker。

配置坏了会落到 `never`。二次开发时不要把「默认 always」写成「坏文件也 always」。

broker 对单个连接有令牌桶限速：突发用光就暂时不处理新帧。这是防本机失控循环，不是用户可调的 QPS 产品。邮箱投递还有一条防重：同一发送方、同一指纹的消息不会无限堆积。发送方 `cancel` 只能拆掉 **还在邮箱里、且是自己寄出** 的那封；已经 `socket_delivered` 的，cancel 变成「请对方别再当未完成 ask 处理」的控制帧，不是时光机。

`exact-send-v1` 能力位存在，是为了让发送方知道对端能不能按稳定 id 精确投递。缺这个能力时，名字寻址的歧义处理更保守——多个离线同名会话抢邮箱时，broker 会拒绝而不是猜一个。

## 7. 纵向链路二：ask 为什么比 send 重

`ask` 把「我需要一个答案」写进 `expectsReply`。发送方工具调用不结束，直到：

- 对端用 `reply` 对上这条 message id，或
- 超时（环境变量 `PI_INTERCOM_ASK_TIMEOUT_MS`，默认 10 分钟，属易变），或
- 本会话关机、broker 拆掉、发送方 cancel。

broker 侧硬规则：**阻塞型 ask 不进邮箱**。理由很具体——发送方正在等一个活人口供，把信丢进「对方哪天回来再读」的盒子里，只会让工具调用挂到超时。所以 ask 的失败形态是「现在找不到人」，不是「已排队」。

接收方的 `ReplyTracker` 记住「哪些 ask 还没答」。新 turn 开始时，它把最近一条入站上下文当成当前回复对象，这样模型可以说人话 `action: "reply"`，而不必每次抄 id。多个待回复冲突时，它要求你改用完整 session id 或显式 `replyTo`——这是为了防止把答案寄错人。

完成 ≠ 就绪：ask 工具返回了，只说明 **你要的那句回复到了**。对端会话可能已经开始下一轮，也可能只是人在 overlay 里随手回了一句。

## 8. 纵向链路三：扩展总线和子代理，不是第二条 IM

broker 还认一组 `extension_*` 帧：别的扩展可以声明 namespace、选一个 owner、在会话之间传 payload、做带 revision 的状态提交。这是 **给扩展作者的旁路**，不是给模型用的第二个 `intercom` 工具。状态提交带着 revision，后写覆盖要能说清「我基于哪一版」；冲突时 `committed: false`，调用方自己决定重读还是放弃。`index.ts` 里的 outbox 事件（`INTERCOM_OUTBOX_REQUEST_EVENT`）让其它扩展借用同一条发送通道，而不自己再开一套 socket。借用方看到的成功同样停在 broker 交割，不保证对端已经开 turn。

同样，`contact_supervisor` 只在子代理场景出现。主会话里看不到这个工具。不要把「子代理能喊监督者」推广成「任意两个会话都有父子关系」。

会话状态（idle / thinking / 正在跑哪个工具）是发送方扩展根据 `agent_start` / `tool_execution_*` / `turn_end` 推到 broker 的 presence。列表上的 status 是 **对方扩展最近一次上报**，有延迟，不是内核级进程状态。

## 9. 边界、概念区分、常见误区

**会话列表 ≠ 本机所有 Pi。** 没装本扩展、加载失败、或 `enabled: false` 的窗口，对 broker 来说不存在。

**名字 ≠ 稳定地址。** `/alias` 是给人看的。进程重启后默认 id 会变；要跨重启点名，得配 `stableId`（易变键名，稳定含义是「你自己声明的不变句柄」）。

**socket_delivered ≠ injected ≠ 模型已读。** 三层回执不要压成一个勾。

**send 可排队，ask 不能。** 把 ask 理解成「带已读回执的 send」会在对端掉线时踩坑。

**没有独立 transcript。** `grep` session jsonl 里的 `intercom_` 自定义类型，能看到发出/收到的痕迹；那是宿主历史，不是 inbox 产品。

**同机信任不是认证登录。** Unix socket 权限 + Windows `stateId` 挡的是「随便连」，不是多用户 ACL。`trustedLocal` / `peerUid` 是提示，不是账号系统。

**不要和 pi-subagents 的原生监督通道抢。** 环境里已经有 supervisor channel 时，本扩展不会再挂 `contact_supervisor`，避免两条喊人路径。

## 10. 失败形态与排错

按现象找层，不要一上来改 UI。

| 现象 | 先查哪一层 | 常见原因 |
|---|---|---|
| 列表是空的 | 运行形态 / 注册 | 对方没加载扩展；broker 没起来；`PI_INTERCOM_SCOPE_ID` 把你们隔开了 |
| send 成功但对方没动静 | 注入策略 | `inboundTrigger` 是 `never`/`replies`；对方正在跑 turn，消息只是 steer |
| send 返回 queued | 投递层 | 对端当时不在线。等对方重连，或改用 id 避免重名邮箱 |
| ask 立刻失败 | broker 路由 | 对端断开。ask 故意不排队 |
| ask 一直转圈 | 接收 / 回复 | 对端没 `reply`；超时还没到；ReplyTracker 对不上来源 |
| Windows 连不上 | 传输 | 端口文件 / `stateId` 过期，broker 刚重启 |
| 配置一改，入站全部不触发 | 失败关闭 | `config.json` 解析失败，策略被落到 `never` |
| 子代理喊不到人 | 变体入口 | 没有 child orchestrator 元数据，或已经走原生 supervisor channel |

broker 自己不写业务日志文件。启动失败时，spawn 路径会截一段 stderr（有上限）。排错优先看：会话是否 `session_start` 连上、socket/端口文件是否存在、对端是否真在 list 里。

## 11. 总结：可验证的稳定事实

1. 这是 **本机 1:1 转发**，不是群聊、不是网络服务、不是独立 inbox。
2. 进程真相：Pi 会话进程 + **按需 broker**。没人连就退出；重拉 broker 不丢聊天记录，因为它不保存聊天记录。
3. 权威目录是 broker 的连接表；权威正文是那一帧；权威「是否开 turn」是接收方策略。
4. `send` 可以进 24 小时邮箱；`ask` 对端必须在线。两种 action 不要当成同一种投递。
5. 自定义 session 条目只是痕迹，不是产品级收件箱。

主线：

```text
点名 → 本机 broker 转发 → 对端注入
        ↑ 在线交 socket
        ↑ 离线 send 才进邮箱
        ↑ ask 从不进邮箱
        ↑ 注入之后才可能开 turn
```

## 12. 源码阅读顺序

二次开发按这个顺序读，比按文件名字母序快：

1. `package.json`：确认它是 Pi 扩展 + 自带 `skills/`，入口是 `index.ts`。看了能懂「宿主怎么发现它」。
2. `broker/paths.ts` + `broker/spawn.ts`：socket / TCP / pid / 启动锁。看了能懂「broker 谁拉起、文件权限为什么是 0700/0600」。
3. `broker/broker.ts`：目录、邮箱、ask 拒绝排队、空闲 5 秒退出、扩展总线。这是转发真相。
4. `broker/client.ts`：发送 API、重连、存活探测。看了能懂客户端以为的 `delivered`。
5. `types.ts` + `broker/protocol.ts`：投递状态和回执枚举。看了能懂完成 ≠ 就绪。
6. `index.ts` 的 `session_start` / `sendIncomingMessage` / `inboundTrigger`：注入与开转。
7. `index.ts` 里 `intercom` 工具的 `action` 分支，以及条件注册的 `contact_supervisor`。
8. `reply-tracker.ts`：ask/reply 如何对上人。
9. `config.ts`：失败关闭行为。改默认策略先看测试 `config.test.ts`。
10. `ui/session-list.ts`、`ui/compose.ts`、`ui/inline-message.ts`：只影响人怎么点，不改变投递语义。
11. `skills/pi-intercom/SKILL.md`：给模型看的用法合同，不是运行时。

测试是行为合同：`broker/*.test.ts` 覆盖成帧、抢锁、存活；`intercom.integration.test.ts` 才把客户端和 broker 串起来。改「ask 能否排队」这种语义，先改测试再改 `broker.ts`。

本地冒烟：两个终端都 `pi install` 本扩展并 `/reload`，各 `/alias` 成 `a` / `b`。在 a 里 `intercom({action:"list"})` 能看到 b，再 `send` 一条；b 的屏幕出现内联消息，即投递链通了。再试一次 `ask`：把 b 退出后再 ask，应当立刻失败而不是 queued。

## 参考资料

- [pi-intercom README](https://github.com/nicobailon/pi-intercom)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- 同仓库姐妹扩展：`pi-subagents`（子代理委派；本包的 `contact_supervisor` 是它的逃生口，不是替代品）
