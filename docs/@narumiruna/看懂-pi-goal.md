# 看懂 pi-goal：给当前会话一个目标，空闲了再续跑

> 本文面向已经会用 Pi 跑一轮对话的读者。需要把「模型停下来」和「Pi 真正空闲」区分开：中间可能还有重试、压缩、排队中的用户消息。
>
> 源码基线：`@narumitw/pi-goal` **v0.54.4**（本仓库 `@narumiruna/pi-goal`）。命令参数、默认续跑上限、UI 文案易变；稳定认知放在「单目标、空闲边界续跑、显式终态工具」上。
>
> 官方说明：[README](../../@narumiruna/pi-goal/README.md) · [npm](https://www.npmjs.com/package/@narumitw/pi-goal)

本文定位：小/轻量偏中，二次开发深度。Goal 与 Plan 的互斥是合作协议，不是彼此发现。

## 1. TLDR：它到底是什么

pi-goal 给**当前会话**一个目标，让 Pi 在真正空闲之后自动再开一轮，直到目标被明确结束或被安全阀拦住。

```text
用户 /goal <objective>
→ 扩展创建 ActiveGoal，写入 session，注入 goal-contract
→ 模型干活；要停必须调 goal_complete / goal_blocked / goal_wait
→ agent_end：记账、安全检查、记下「该不该续」
→ agent_settled：宿主完全空闲后，最多发出一轮 continuation
→ 完成 / 阻塞 / 等待 / 暂停 / 预算或安全上限
```

所以它不是：

- 不是多目标队列（`add` / `skip` / `push` 等子命令已经移除）；
- 不是独立 daemon。没有 Goal 服务器，定时器在 Pi 进程里；
- 不是 `/plan`。Plan 管「先只读规划」，Goal 管「朝着一个目标接着干」，二者用工作流互斥合作，但不互相启动；
- 不是 todo 清单。todo 只显示步骤，不会在空闲后续跑。

正面定义：**会话级单目标状态机，续跑点钉在 Pi 的 settled idle 边界上。** 判断「目标是否真的完成」的是宿主 Agent（它必须调用终态工具并给出证据）；扩展负责不在错误的时间点再踢一脚，以及在工具丢失、预算用尽、无进展时停下来。

权威状态是 **session 分支里的 `goal-state` 条目**（另有 `goal-contract` 消息给模型看当前契约）。`pi-goal.json` 只是续跑上限等设置。磁盘上的 `pi-goal-state.json` 只用于清理旧版按 cwd 持久化的遗留，不是当前权威源。

## 2. 为什么必须等 settled，而不是 agent 一结束就续

一轮 Agent 结束（`agent_end`）不等于机器没事了。Pi 还可能：

- 做 provider 重试；
- 做压缩（compaction）；
- 处理已经排队的用户输入。

如果在这些事情中间插入「继续目标」，会出现抢跑：压缩还没写完就再要一轮，或用户刚打的字被目标提示顶掉。

所以生命周期被拆成两段：

- `agent_end`：记账、判断是否 *请求* 续跑；
- `agent_settled`：确认空闲后，才 *真正发出* 那一轮 continuation。

该用：目标能验证（测试、diff、明确验收），值得让模型在你不盯着的时候继续。

不该用：探索性闲聊、需要每步人工拍板的设计、或「同时推进三件无关的事」。后者应拆 session，而不是幻想队列回来了。

默认安全阀（设置可改）：自动模型轮次上限 25，无进展轮次上限 3。无进展指连续几乎没动工具、输出还很像上一轮。

## 3. 先看整体架构，不急着看类名

```text
Pi 宿主
 └─ goal.ts 组装 runtime
     ├─ command-registration.ts / commands.ts   /goal 路由
     ├─ tools.ts                                三个终态工具
     ├─ lifecycle.ts                            绑 session / agent 事件
     ├─ runtime.ts                              状态转移、续跑、会计
     ├─ run-protocol.ts                         可选的托管 run 总线（默认关）
     ├─ persistence.ts                          session 条目 ↔ ActiveGoal
     ├─ goal-contract.ts                        给模型看的当前契约
     ├─ safety.ts / accounting.ts / wait.ts     安全、token、等待
     └─ workflow-mutex.ts                       与 Plan 等合作互斥
```

| 层 | 收到什么 | 做什么 | 产出什么 |
|---|---|---|---|
| 命令 | `/goal ...` | 解析 start/pause/resume/edit/clear/status | 一次状态转移 |
| 契约 | 当前 ActiveGoal | 写成 goal-contract 消息 | 模型可见的 goal_id 与规则 |
| 工具 | complete/blocked/wait | 校验 goal_id，拒绝过期调用 | 终态或等待 |
| 会计 | 每轮 usage | 累加 token/时间，对照预算 | 可能变成 budget_limited |
| 生命周期 | Pi 事件 | 在正确边界请求或发出续跑 | 下一轮 prompt 或停止 |
| 持久化 | ActiveGoal | 写入 `goal-state` | 恢复会话后仍在 |

图纸上的「Goal 引擎」是代码职责。进程真相：**就是当前这个 Pi 进程。** 没有旁路 worker，也没有第二条 Agent 循环。所谓续跑，是往**当前 session** 再投一条带所有权标记的 follow-up 用户消息（`pi.sendUserMessage(..., { deliverAs: "followUp" })`），让宿主自己的模型循环再跑一轮。`goal_wait` 的唤醒也只是进程内定时器，Pi 都退出了就不会自己回来。

## 4. 实际怎样运行：挂在宿主事件上的状态机

证据：`pi.extensions: ["./dist/index.ts"]`。`goal.ts` 的注册顺序写得很清楚：先 run-protocol 总线，再工具，再命令，再 lifecycle——避免监听器还没挂上就开始跑。

装了什么：npm 包、Agent 目录 `pi-goal.json`。目标本文存在当前 session，不进 git。

有没有常驻进程：**没有。** 有的是：

- continuation 调度（仍在宿主事件循环）；
- `goal_wait` 的 `resume_after_ms` 定时器；
- 状态栏短暂提示用的 timer。

这些都随 session_shutdown 被清掉。还有一个 `setTimeout(..., 0)`：压缩刚结束时 Pi 可能还没清 controller，立刻 `sendUserMessage` 会被拒，所以把 dispatch 推到下一个事件圈。

和宿主 / 其他扩展的关系：

```text
Pi 宿主进程
 ├─ 模型循环
 ├─ 本扩展（单目标 runtime）
 └─ 可选：pi-plan-mode（同一套 Workflow Mutex v1）
```

互斥是合作的：两边都实现 v1、跑在被描述过的 Pi 版本上，才保证不同时占工作流。Goal **不识别、不启动、不配置** Plan。版本不够就各自 standalone，互斥不受支持。

谁拉起归谁：用户 `/goal` 或 resume 拉起；模型不能用工具「凭空打开 Goal 模式」。工具描述写明：工具可见 ≠ Goal 已激活。

## 5. 一条真实输入：`/goal 实现登录` 直到完成

```text
命令解析
→ 创建 ActiveGoal（uuid、状态 active）
→ 占用 workflow mutex
→ 写入 goal-state + 注入 goal-contract
→ 发出第一轮目标 prompt
→ 模型工作（普通工具 + 三个终态工具）
→ agent_end 请求续跑
→ agent_settled 发出下一轮
→ goal_complete 验证后停
```

### 5.1 命令层：空参数是 show，其它文本是 start

`parseCommand` 把 `pause` / `resume` / `clear|stop` / `status` / `edit` 和「剩下的都当 objective」分开。可带 `--tokens` 预算。已删除的队列子命令会明确告诉你它们不在了。

同步、纯代码。还没有模型。

### 5.2 运行时层：一份 ActiveGoal

字段包括 id、文本、status、迭代次数、token 预算与已用、自动轮次、无进展计数、可选 waiting。同一时刻一份。替换旧目标前，若旧的还是 active，会先结算用量。

status 只在这几个值里走：`active | paused | blocked | usage_limited | budget_limited | complete`。终态不能靠续跑自己活回来，要用户 `resume`（且不是 complete）。

### 5.3 契约层：模型必须带着当前 goal_id 说话

`goal-contract` 告诉模型：现在 Goal 是开的、id 是什么、怎样才允许 complete/block/wait。压缩前会调和契约，避免模型拿着过期 id 把已经换掉的目标标完成。

### 5.4 工作层：三个终态工具是停下来的正门

| 工具 | 何时 | 额外约束 |
|---|---|---|
| `goal_complete` | 每条要求都已验证 | 摘要必须是完成证据，不是进度汇报 |
| `goal_blocked` | 同一外部阻塞反复出现 | 要 evidence 和 repeated_turns |
| `goal_wait` | 等外部事件 | 可带延迟；到点后安静恢复，而不是当成永久 blocked |

goal_id 对不上就拒绝——这是为了挡住「上一轮还在飞的 stale tool call」。生命周期里也有专门挡住过期 Goal 工具调用的逻辑。

### 5.5 空闲边界层：请求续跑 ≠ 已经续跑

`agent_end` 可以 `requestContinuation`，但只把 continuation **写在内存 ticket 里**（prompt + `<!-- pi-goal-continuation: ... -->` 标记）。真正 `dispatchContinuationIfSettled` 发生在 `agent_settled`：确认空闲、仍 active、非 waiting、工具还在、没撞安全上限，才把那条 follow-up 发出去。若当时 Goal 已经不拥有 workflow（例如 Plan 插进来），续跑被取消。

`before_agent_start` 用标记认领「这一轮是不是 Goal 自己的 prompt」，避免把用户手动输入算成自动轮次，也避免硬上限误杀 Pi 自己的重试。

**reload / 换 factory 实例不会自动再踢一脚。** session 能恢复 `ActiveGoal` 和等待定时器；内存里的 continuationIntent 不落盘。打开一个 active 目标后，通常要等下一次 settled 或用户 `/goal resume`，而不是指望扩展自己记得「上次正要续」。

### 5.6 等待与压缩

`goal_wait` 把目标保持为某种可恢复的等待，而不是直接 blocked。到点后仍要等 settled 再 dispatch。压缩时 active 目标会先记账；预算耗尽的目标可以取消将重试的压缩，以免在已经没预算时还折腾上下文。

完成 ≠ 代码已合并：complete 只证明模型在契约仍有效时提交了验证过的摘要。Git/CI 是你的事。waiting 到期 ≠ 外部事件已发生，只是允许模型再去看一眼。

## 6. 边界、误区和排错

| 词 | 是 | 不是 |
|---|---|---|
| ActiveGoal | 当前 session 的唯一目标 | 全局任务队列 |
| continuation | settled 后最多再踢一轮 | 死循环 while true |
| goal-contract | 给模型的当前有效契约 | 用户文档 |
| workflow mutex | 合作占用 | 扫描并关闭别的扩展 |

常见误区：

- 「Goal 一开就会不停跑到天荒地老。」错。正：有自动轮次上限、无进展上限、预算、工具缺失暂停、用户 abort。
- 「模型输出『我做完了』就是 complete。」错。正：必须成功调用 `goal_complete`，且契约仍说 Goal 有效。
- 「和 Plan 谁优先级高？」错问题。正：同一时刻只应有一个占用 mutex 的工作流；版本不对则互斥不受支持。

症状式排错：

- **目标在，但不再续跑**：先看 status 是不是已经 paused/blocked/waiting/budget_limited，再看 `goal_complete` 与 `goal_blocked` 是否还在 active tools 里（`goal_wait` 不是开工所必需），再看是不是没到 settled，再看是不是刚 reload——intent 不在磁盘上。不要先改 prompt 文本。
- **刚完成却被旧轮次又改了状态**：先查 goal_id 和 stale tool call 阻挡。runtime 必须忽略非当前 id 的回调。
- **resume 没反应**：complete 不可复活；usage_limited 要等额度；waiting 可用手动 resume 提前叫醒。

当前可靠性边界：续跑不是数据库事务，continuation ticket 也不进 session。进程在 settled 之后、follow-up 发出之前崩溃或 `/reload`，磁盘上仍可能是 active，但**不会**有外部 watchdog 或自动再投的那一轮。waiting 到期除外，因为它靠恢复后的进程内定时器。

## 7. 总结

1. 单目标、会话级；权威状态在 `goal-state`，不在独立服务。
2. 续跑点是 `agent_settled`，手段是带标记的 follow-up 用户消息；intent 只在内存。
3. 停下来走三个显式工具；开工至少要 `goal_complete`+`goal_blocked` 可见。工具可见不等于 Goal 模式已开。
4. 与 Plan 的共存是合作 mutex，Goal 不发现对方。

如果只记一条主线：

```text
/goal → ActiveGoal + contract → 模型干活 → agent_end 请求续跑
→ agent_settled 发出续跑 → complete/block/wait/安全阀 停止
```

## 8. 深入通道：源码阅读顺序

1. `src/index.ts` / `src/goal.ts` — 组装顺序。
2. `src/command.ts` — 命令语法；看队列为什么不在了。
3. `src/commands.ts` — start/pause/resume/clear 怎么改 runtime。
4. `src/tools.ts` — 三个终态工具的拒绝条件。
5. `src/lifecycle.ts` — 事件边界。**先读这个再读 runtime 细节。**
6. `src/runtime.ts` — 转移、续跑调度、会计、stale call。
7. `src/goal-contract.ts` — 模型看到的契约如何调和。
8. `src/persistence.ts` — session 条目 vs 遗留磁盘文件。
9. `src/safety.ts`、`src/accounting.ts`、`src/wait.ts` — 无进展、预算、等待。
10. `src/workflow-mutex.ts`、`src/run-protocol.ts` — 互斥与默认关闭的托管总线。
11. `test/` — interrupted、reload、budget；这是状态机合同。

二次开发时每加一种异步工作，都要有取消句柄和 goal id/instance 校验。旧回调写新目标，是这个包最典型的 bug 形态。
