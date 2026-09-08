# 看懂 pi-chat：聊天走旁路，不进模型上下文

> 本文面向第一次接触该扩展的读者。需要知道 Pi 的 TUI 会话是什么；不需要懂 Hyperswarm 的协议细节。
>
> 源码基线：`@narumitw/pi-chat` **v0.1.6**（本仓库 `@narumiruna/pi-chat`）。邀请码格式、房间 UI 和 DHT 实现易变；稳定认知放在「聊天和 Agent 循环隔离」以及「网络何时存在」上。
>
> 官方说明：[README](../../@narumiruna/pi-chat/README.md) · [npm](https://www.npmjs.com/package/@narumitw/pi-chat)

本文定位：小/轻量，二次开发深度。

## 1. TLDR：它到底是什么

pi-chat 让开发者在 Pi 的终端里和别人进同一个短暂房间。主线不是「让模型会聊天」，而是把聊天从 Agent 循环里拆出去：

```text
用户 /chat（或邀请码 / #公开房间）
→ 扩展加入 Hyperswarm 房间
→ 独立 composer + dock 收发消息
→ 消息留在聊天 UI 里
→ 不进 prompt、不进模型上下文、不进仓库、不进 Agent 输出
```

所以它不是：

- 不是给模型的即时通讯工具——它甚至不注册模型工具；
- 不是 Slack/Discord 客户端，没有账号体系，也不是可靠投递服务；
- 不是匿名聊天。公钥指纹会显示在昵称旁边，方便当面核对；
- 不是 Pi 的 session 日志。换会话、关 Pi，房间连接按生命周期拆掉。

正面定义：**寄生在 Pi TUI 上的点对点聊天客户端。** 判断聊什么的是人；扩展只负责发现对端、加密直连、把 UI 画在编辑器旁边。

权威内容是 **房间内正在发生的实时消息**。设置文件只记昵称、widget 模式、是否记住房间，不是聊天记录库。

## 2. 为什么必须和模型上下文切开

如果把聊天当普通用户消息塞进 Pi，会出现三件坏事：别人随口说的话变成指令、上下文被噪声占满、聊天记录进 git/session 后难以清理。

该用：人在跑 Agent 的同时，需要和同事对一下「现在卡在哪」，又不希望这些话被模型当成任务。

不该用：要可靠、可审计、可搜索的团队通讯；要让 Agent 根据聊天内容自动干活。后者需要别的桥，本扩展故意不提供。

职责分工：

| 谁 | 管什么 | 不管什么 |
|---|---|---|
| 用户 | 加入哪间房、说什么 | 协议细节 |
| 扩展 | 身份、发现、加密流、TUI | 模型 prompt |
| Hyperswarm / HyperDHT | 找对端、Noise 加密流 | 消息是否该进 Agent |
| 宿主 Pi | 提供 TUI 和 session 生命周期 | 不解释聊天内容 |

README 写得很硬：Pi Chat 不是匿名服务，也不是可靠消息服务。DHT 和对端可以观察到网络元数据。公开房间在加入前会确认。

## 3. 先看整体架构，不急着看类名

```text
Pi TUI 宿主
 └─ pi-chat.ts（命令、session 生命周期、加入/离开）
     ├─ 身份：identity.ts（首次加密才加载 DHT/sodium）
     ├─ 房间描述：room.ts（私钥邀请 / 公开 slug）
     ├─ 会话：chat-session.ts（消息、草稿、对端）
     ├─ 传输：network.ts + directory-network.ts
     ├─ UI：menu.ts / chat-view.ts / widget.ts（按需加载）
     └─ 设置：pi-chat.json
```

| 层 | 收到什么 | 做什么 | 产出什么 |
|---|---|---|---|
| 命令 | `/chat` 参数 | 菜单、解析邀请、确认公开房 | 一次 join |
| 房间 | 邀请或 slug | 得到可发现的 topic | `RoomDescriptor` |
| 网络 | descriptor + 身份 | 加入 swarm、签发有界事件 | 加密直连 |
| 会话 | 网络事件 / 本地输入 | 维护快照、草稿 | 给 UI 的 snapshot |
| UI | snapshot | composer + dock | 屏幕上的聊天 |
| 设置 | 磁盘 JSON | 记住房间和外观 | 下次恢复用的线索 |

图纸上有「网络层」。进程真相是：**没有单独的 chat daemon。** Hyperswarm 跑在 Pi 宿主进程里；`session_shutdown` 或换会话会 abort 并断开。懒加载很彻底：菜单、composer、加密实现都在第一次用到时才 import。

## 4. 实际怎样运行：TUI 扩展，网络随会话生灭

证据：`pi.extensions: ["./dist/index.ts"]`，依赖 `hyperdht`、`hyperswarm`、`sodium-universal` 和 `@narumitw/pi-tui-kit`。唯一命令是 `/chat`。非 TUI 模式直接报错。

装了什么：npm 包 + Agent 目录下的 `pi-chat.json`。身份密钥按实现懒加载，不把聊天写进仓库。

有没有常驻进程：**没有独立进程。** 加入房间后，宿主进程里会有 DHT/swarm 的网络 I/O 和定时任务（扩展用 `ownedTasks` 跟踪）。离开房间、session 被替换、扩展关闭时，这些任务被 abort 并 drain。

和宿主的关系：

```text
Pi 宿主进程
 ├─ 正常的模型会话（看不到聊天）
 └─ 本扩展
     ├─ TUI widget / composer
     └─ Hyperswarm 连接（随 session 生灭）
```

被谁拉起归谁：用户执行 `/chat`，或 TUI 下 `session_start` 恢复记住的房间时才连网。扩展加载本身不上 DHT。没加入房间时，它只是一个注册过的命令。公开房间浏览还会再开**第二个** in-process swarm（目录 topic），和当前房间不是同一张网。

## 5. 一条真实输入：用邀请码进房并说话

```text
/chat pichat:<邀请>
→ 解析为私人房间
→ 加载身份
→ 加入 swarm
→ 打开 composer
→ 发送：签名并经 Noise 流出去
→ 接收：校验后画到 dock
→ 离开 / session_shutdown：断开
```

### 5.1 命令层：三种进法

- 空参数：打开菜单（创建/加入/设置）；
- `pichat:` 前缀：私人房间邀请，解析失败则提示用法；
- `#slug`：公开房间，先确认「任何人可加入或记录」。

公开房间和私人房间的差异在发现范围，不在「会不会进模型」。两种都不进 prompt。

### 5.2 身份与房间层

身份是密钥对，UI 上用稳定指纹辅助核对。私人房间靠 bearer 邀请；公开房间靠 slug。这一步还没有消息，只有「去哪发现对端」。

### 5.3 网络层：发现之后是直连

扩展用 Hyperswarm 做发现，用 Noise 加密流做直连。事件有大小边界，签名后中继。这是尽力而为的实时通道：对端离线、NAT 失败、DHT 抖动都会丢消息，扩展不提供重放邮箱。

### 5.4 UI 层：独立 composer

聊天输入不是 Pi 底部那个给模型的编辑器。草稿可以保留；widget 可以记住上次的表面。**当前直连邻居为 0 时不发送**（草稿留下），因为没有可写的 socket。邻居上限是 8，更大的房间靠 gossip 转发，不是全连接。本地 transcript 有上限（当前 256 条），离开即清空，**不写进 `pi-chat.json`**。

模型正在跑工具时，你仍可以在旁路说话——这两条输入流故意不汇合。

### 5.5 关闭层

换 session 会 abort 旧 controller、断开房间、drain 任务，再按设置决定要不要恢复记住的房间。恢复失败会打 status，不会把失败原因塞进模型。

同步/异步：命令处理是 async；网络事件是异步回调。没有「消息已发送」就等于「对端已读」的完成态。完成 ≠ 投递成功。

## 6. 边界、误区和排错

| 词 | 是 | 不是 |
|---|---|---|
| 私人房间 | 持邀请才能发现 | 服务器端访问控制 |
| 公开房间 | slug 可被任何人加入 | 安全的团队频道 |
| 指纹 | 便于当面核对身份 | 实名认证 |
| 设置里记住的房间 | 下次自动尝试加入 | 聊天记录备份 |

常见误区：

- 「装了 pi-chat，模型就能跟用户聊天。」错。正：模型根本没有 chat 工具。
- 「私人房间等于加密到只有两个人能看。」错。正：邀请是 bearer；拿到邀请的人都能进。传输有加密，邀请分发没有额外权限模型。
- 「断开后又连上，没看到的消息会补回来。」错。正：不是可靠消息服务。

症状式排错：

- **命令能开菜单，但加不进**：先确认 TUI 模式、防火墙/DHT、邀请是否完整。不要先怀疑 composer 渲染。
- **能进房但对方看不到你**：先核对指纹和是否真的建立直连，而不是看 Pi session 日志——聊天本来就不在那里。

当前可靠性边界：没有服务端存储，没有已读回执，没有跨会话消息历史。这是产品边界，不是漏做。

## 7. 总结

1. 它是 TUI 旁路聊天，不注册模型工具，消息不进 prompt。
2. 网络跑在 Pi 宿主进程里，随 session 生灭，没有 chat daemon。
3. 私人房间靠邀请，公开房间靠 slug；两者都不是账号系统。
4. 设置只记偏好和可选的房间线索，不是聊天数据库。

如果只记一条主线：

```text
/chat 加入房间 → Hyperswarm 直连 → 独立 UI 收发 → 离开即断 → 模型始终看不见
```

## 8. 深入通道：源码阅读顺序

1. `src/index.ts` — 入口转发。
2. `src/pi-chat.ts` — 命令、session 生命周期、join/open/disconnect。看了能懂「和模型循环如何隔离」。
3. `src/room.ts` — 邀请与公开房间描述。
4. `src/identity.ts` — 为什么加密实现要懒加载。
5. `src/chat-session.ts` — 快照、草稿、本地事件。
6. `src/network.ts`、`src/network-contract.ts` — 传输边界和邻居上限。
7. `src/protocol.ts` — 有界、带签名的事件。
8. `src/settings.ts` — `pi-chat.json` 记什么、不记什么。
9. `src/menu.ts` / `src/chat-view.ts` / `src/widget.ts` — 第一次用才加载的 UI。
10. `test/` — 用 mock 网络固定行为；真实网络冒烟是 opt-in。

二次开发时不要把聊天快照挂到 `pi.appendEntry` 或 system prompt。那会直接拆掉这个扩展存在的理由。
