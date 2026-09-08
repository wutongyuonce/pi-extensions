# 看懂 pi-subagents：把任务丢给隔离的子 Pi，用消息来回问

> 本文面向已经会让主 Agent 调工具的读者。需要先接受：这里的「子代理」是**另一份 Pi 进程**，不是主会话里的一个函数调用。
>
> 源码基线：`@narumitw/pi-subagents` **v3.0.1**（本仓库 `@narumiruna/pi-subagents`）。这是相对旧版的重写：没有 chain/fan-in、没有常驻 AgentRegistry、没有跨会话 mailbox。若你读过本仓库 `docs/@narumitw/08-pi-subagents.md`，以本文和当前 `src/` 为准。
>
> 官方说明：[README](../../@narumiruna/pi-subagents/README.md) · [npm](https://www.npmjs.com/package/@narumitw/pi-subagents)

本文定位：小/轻量偏中，二次开发深度。工具参数和并发上限易变；稳定认知放在进程隔离、broker 凭证传递、以及「子进程结束不会自动叫醒空闲的主模型」。

## 1. TLDR：它到底是什么

pi-subagents 让主 Agent 启动隔离的子 Pi 作业，双方在作业活着的时候用请求-响应消息说话。

```text
主模型 subagent_spawn(task, tools?)
→ 立刻返回 jobId（作业可能还在排队）
→ 宿主进程在 127.0.0.1 上开一个 TCP broker
→ spawn 子 Pi：rpc 模式、无 session、无其它扩展
→ 凭证经私有 fd 交给孩子，不放命令行
→ 双方 subagent_send / subagent_wait
→ 孩子结束：主会话收到一条完成消息（不自动开新一轮）
```

所以它不是：

- 不是 Goal。Goal 在**同一会话**里续跑；subagent 是**别的进程**；
- 不是旧版的 parallel/chain/fan-in 编排器，也不是 Agent Teams；
- 不是自定义 agent 目录。孩子的「专业性」来自这次的 `task` 字符串，能力来自这次的 `tools` 列表；
- 不是可恢复的后台工人。reload、换 session、退出 Pi，作业和 broker 请求一起消失。

正面定义：**带本机认证消息总线的子 Pi 作业运行时。** 判断孩子的结论对不对，仍然要主 Agent 去对 diff 和确定性检查；扩展只保证隔离、取消、以及消息在作业活着时能送达。

权威输出是 **该 job 的终态结果文本**（另有隐私过滤的 inspect 元数据）。主会话不会自动继承孩子的工具轨迹。这个包**没有设置文件、没有作业磁盘**。

## 2. 为什么要单独再开一个 Pi，而不是再调一轮工具

主会话上下文宝贵，且一旦把高权限工具留给「顺便去探索」的工作，误写的半径就是整个仓库。

该用：一块可独立描述的任务，默认只读工具就够，结果需要事后核对。

不该用：要和主会话共享未提交的思考、要孩子拥有父进程里的扩展工具或 `--api-key`、要作业在 Pi 关掉后继续跑。

职责分工：

| 谁 | 管什么 | 不管什么 |
|---|---|---|
| 主 Agent | 写 task、选 tools、核对结果、回答孩子的问题 | 不进孩子的进程 |
| 本扩展 | spawn、限额、broker、取消、widget | 不给孩子自定义 system prompt / 记忆 |
| 子 Pi | 在被允许的工具里完成 task | 看不到父扩展、父 runtime key |
| 主用户 | 是否信任项目（`--approve`） | 不直接给孩子打字（除非经主 Agent 转发） |

孩子默认工作工具是 `read`、`grep`、`find`、`ls`。`bash`/`edit`/`write` 必须被明确选进 `tools`。通信工具是另外固定加上的，不占用你这笔名单的语义。

## 3. 先看整体架构，不急着看类名

```text
主 Pi 进程
 └─ subagents.ts
     ├─ tools.ts            主会话五个工具
     ├─ runtime.ts          作业表、并发、完成投递
     ├─ message-broker.ts   本机 TCP + token
     ├─ process.ts          spawn 子 Pi
     ├─ child-communication-bridge.ts  孩子侧桥
     ├─ child-communication-tools.ts   孩子侧 send/wait
     └─ widget.ts           进行中的作业
```

| 层 | 收到什么 | 做什么 | 产出什么 |
|---|---|---|---|
| 主工具 | spawn/inspect/cancel/wait/send | 校验、排队、转发 | jobId 或消息 |
| 运行时 | StartJobInput | 最多 8 个活动作业 | Job 状态机 |
| Broker | 认证过的帧 | 在父子间转发请求-响应 | 有界消息 |
| 进程 | ChildRequest | `pi --mode rpc --no-extensions ...` | 子进程 |
| 孩子桥 | 私有 fd 上的凭证 | 连 broker，注册 send/wait | 孩子能问主 Agent |
| 完成 | 子进程退出 | 截断结果，append 完成消息 | 主会话里的异步记录 |

图纸上的「broker」像服务。进程真相：它是主扩展在 **session_start 时于 127.0.0.1 绑的临时端口**，只给这一次会话的孩子用。不是用户要启动的 daemon，也不是可从局域网访问的 API。

## 4. 实际怎样运行：一主多子，全部由主扩展拥有

证据：`pi.extensions: ["./dist/index.ts"]`。没有 slash command。五个主工具：`subagent_spawn`、`subagent_inspect`、`subagent_cancel`、`subagent_wait`、`subagent_send`。孩子另有同名的 send/wait，契约按上下文区分。

装了什么：npm 包。运行时还要求能解析到宿主那份 `pi`（`process.ts` 从 `@earendil-works/pi-coding-agent` 找包目录）。孩子带 `--no-session --no-extensions --no-skills --no-prompt-templates`，再 `-e` 注入通信桥。

有没有常驻进程：

- 主扩展：随 Pi；
- broker：session 活着时才听 `127.0.0.1:ephemeral`；
- 每个 job：一个子 Pi，AbortController 取消，超时可杀，grace 后强杀。

`session_shutdown` 会停 widget、shutdown 工具层（杀作业、关 broker）。换 session 会 `generation++` 并清空作业表。

和宿主的关系：

```text
主 Pi（有扩展、有 session、有你的工具）
 ├─ 本扩展 runtime + broker(127.0.0.1)
 └─ 子 Pi × N
     ├─ --mode rpc
     ├─ 只有被允许的工作工具 + send/wait
     └─ 凭证：继承的 fd，不是 argv/env 明文
```

谁拉起归谁：`subagent_spawn` 在主模型那一轮里同步返回 jobId，子进程在后台跑。主模型这一轮可以立刻结束——**作业还在跑 ≠ 主会话还在想**。

嵌套 spawn 被拒绝：孩子不是再开孙子的地方。

## 5. 一条真实输入：spawn 一个只读调查，中途被问一句

```text
subagent_spawn({ task, tools: ["read","grep"] })
→ 校验 task 大小、工具名、模型、是否嵌套
→ 拒绝「只存在于父进程的 provider / runtime API key」
→ enqueue（活动上限 8）
→ 确保 broker
→ spawn 子 Pi，把 token+port 经 fd 写入
→ 返回 { jobId, state: "queued" }
→ 孩子跑；可用 send 问主 Agent
→ 主 Agent subagent_wait / subagent_send
→ 孩子退出 → 完成消息进主 session
```

### 5.1 校验层：失败必须发生在 spawn 之前

task 有字节上限；tools 有数量上限，且必须落在允许的核心工具名里。模型继承主 Agent 的有效模型，扩展不提供 per-job 模型覆盖。父扩展注册的 provider、进程内 `--api-key` 不能用——孩子读不到，也不该读到。

这一步同步。失败时没有子进程。

### 5.2 排队层：jobId 不是「已经在跑」

`runtime.start` 先给 queued。真正 `runChild` 是后续任务。inspect 看到的元数据经过过滤，不是孩子 stdout 全文。

完成 ≠ 主模型已经知道：完成消息以 `pi-subagents-completion` 写进 session，**不带 `triggerTurn`**。主 Agent 空闲时，结果会躺在那里直到下一轮用户/模型交互。对比：孩子经 broker 问主 Agent 的那条 `pi-subagents-message` **会** `triggerTurn: true`，因为那是在等你回答。这是时序设计，不是漏了 wakeup。

主侧 `subagent_wait` 超时 **不会取消作业**；只是这次 wait 返回 timed out。孩子侧 wait 超时同样不自动撤掉未完成的请求。

### 5.3 进程层：rpc 是为了后来能 steer

`--mode rpc` 让父进程在初始 prompt 被接受之后，还能把主侧发来的请求注入孩子。`onControl` 在孩子就绪后才能 send。取消、超时、失败都会收敛到一次状态更新，避免双重投递。

输出按 UTF-8 字节截断。JSONL 事件行、结果、错误各有上限，防止孩子把主会话撑爆。

### 5.4 消息层：请求-响应，不是两个模型闲聊

`subagent_send` 要带 recipient=jobId，或回答孩子时带 requestId。`subagent_wait` 可能因为「有消息」返回，而不是因为作业结束。消息不是保留的对话记忆：作业一死，broker 上的未完成请求一起没。

孩子侧的 send/wait 由 bridge 在模型开始用工具前装好。凭证读完就关 fd，降低泄漏。

### 5.5 展示层

TUI 在编辑器上方显示 queued/running 的 id、耗时、超时和**工作工具**（通信工具不展示）。没有活动作业时 widget 消失。这是派生视图，权威仍是 runtime 的作业表。

## 6. 边界、误区和排错

| 词 | 是 | 不是 |
|---|---|---|
| job | 一次子 Pi 进程 | 可恢复的云任务 |
| broker | session 级本机端口 | 公网消息总线 |
| send/wait | 作业活着时的请求-响应 | 孩子之间的 P2P |
| 完成消息 | 终态记录 | 自动续跑信号 |

常见误区：

- 「spawn 返回了就是孩子跑完了。」错。正：返回的是 queued/jobId。
- 「孩子结束了，主模型会马上总结。」错。正：不叫醒空闲主模型。要用 wait，或等下一轮。
- 「给孩子 bash，它就和主会话一样能用我的 MCP/扩展。」错。正：`--no-extensions`，只有点名的核心工具。
- 「这还能做 fan-in 工作流。」错。正：v3 明确不做 chain/fan-in/DAG/mailbox。要编排，在主 Agent 里自己调多次 spawn。

症状式排错：

- **spawn 失败，说 key/provider**：改用环境或已存储、孩子进程读得到的凭据。不要试图把父进程内存里的 key 传下去。
- **能 spawn 但不能 send**：作业是否已经终态、control 是否就绪、是不是用了过期 jobId。`session_start` 时 broker 启动失败会被吞掉，要到下一次 spawn 的 `assertReady()` 才爆出来。
- **reload 后作业全没了**：设计如此。不要去 session 文件里找子进程状态——本来就没持久化。

当前可靠性边界：没有跨父子的总事务。孩子已经改了磁盘，主侧再 cancel，磁盘不会回滚。主 Agent 必须自己核对工作区。并发写同一 cwd 的风险由「少给写工具」来降，而不是文件锁。

## 7. 总结

1. 子代理 = 隔离 Pi 子进程 + 本机认证 broker，不是线程，不是同一会话的分身。
2. spawn 立即返回 jobId；完成不自动叫醒空闲主模型。
3. 孩子无扩展、无父 runtime key、无嵌套 spawn；默认只读工具。
4. 作业和消息不跨 reload/session/进程存活。

如果只记一条主线：

```text
spawn → jobId → broker+子 Pi → send/wait（可选）→ 子进程终态
→ 完成消息入主 session（主模型空闲则先躺着）
```

## 8. 深入通道：源码阅读顺序

1. `src/index.ts` / `src/subagents.ts` — session_start 才 startSession。
2. `src/tools.ts` — 五个主工具的校验与返回值。
3. `src/types.ts` — 作业状态、默认工具、核心工具白名单。
4. `src/runtime.ts` — 并发、generation、完成投递、取消。
5. `src/process.ts` — 精确的 argv 和 fd 传凭证。看了就能驳倒「孩子会加载用户扩展」。
6. `src/broker-credentials.ts`、`src/message-broker.ts` — token 与本机端口。
7. `src/child-communication-bridge.ts`、`src/child-communication-tools.ts` — 孩子看见的契约。
8. `src/model-output.ts` — 为什么所有跨边界文本都要有界。
9. `src/widget.ts`、`src/completion-renderer.ts` — UI 与完成消息怎么进 transcript。
10. `test/` — 协议、取消、abort、生命周期。并发和 abort 最重要。
11. `docs/`、`skills/using-pi-subagents/` — 给模型看的委托说明，不是运行时依赖。

二次开发不要把「常驻 registry / 跨会话 mailbox」加回 spawn 工具。那是 v3 刻意删掉的复杂度；真需要持久对话，应另做扩展，而不是把作业表写成数据库。
