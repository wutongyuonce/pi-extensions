# 看懂 pi-tasks：任务清单是权威，子 Agent 只是可选执行器

> 本文面向已经会用 Pi、在会话里见过 `TaskCreate` / 编辑器上方那条任务列表的读者。本文定位：**二次开发深度**。先讲清「这不是 Pi 内置工具、也不是子 Agent 运行时」，再走一条从建任务到（可选）执行的链路。
>
> 源码基线：本仓库 `@tintinweb/pi-tasks`，包版本 `0.9.0`（CHANGELOG 2026-08-24，自称 Early release）。父仓库 HEAD `6f1c21c`（2026-09-08）。vendored 快照。工具描述对齐 Claude Code，文案会变；**稳定认知放在：谁是权威表、执行器在不在、提醒是不是写进历史。**
>
> 权威源：[上游 README](https://github.com/tintinweb/pi-tasks)、[CUSTOMIZING.md](https://github.com/tintinweb/pi-tasks/blob/master/CUSTOMIZING.md)。同系列：[看懂 pi-subagents](./看懂%20pi-subagents.md)、[看懂 pi-schedule-prompt](./看懂%20pi-schedule-prompt.md)。

## 1. TLDR：清单和工人不是同一个扩展

多步工作在 Pi 里没有原生任务表。`pi-tasks` 补上 Claude Code 形状的七个工具、一块常驻 Widget、磁盘上的任务 JSON，以及——**仅当同进程里装着 `pi-subagents` 时**——按依赖把任务交给子 Agent 跑。

它做的事情可以压缩成两条可独立成败的链路：

```text
记账（永远能用）：
模型 TaskCreate / 人 /tasks
  → 写入当前范围的 tasks JSON
  → Widget 刷新
  → 若干回合后可能注入一条瞬时 <system-reminder>
  → 完成若干回合后可能被自动清掉

执行（可选）：
模型 TaskExecute
  → 进程内 RPC 问 pi-subagents 要不要 spawn
  → 子 Agent 跑完回写任务状态
  → 若开了 autoCascade，给解阻的下游再 spawn
```

所以它不是：

- **不是 Pi 内核自带的 TaskCreate。** Pi coding-agent 不随包装这七个工具。你在某个会话里能调 `TaskCreate`，是因为加载了本扩展。加载之后，宿主的任务工具**就是**本包，没有第二份内置列表。
- **不是子 Agent 运行时。** 工人是 `pi-subagents`。本包只维护清单，执行时发事件问路。没装对面、协议版本不对：记账仍可用，`TaskExecute` 返回一段错误文本，任务停在 pending。
- **不是守护进程 / CLI / 库。** 无 `bin`、无 `main`。工厂 `export default function (pi)`，活在宿主进程里，进程退了它就没了。
- **不是进程监控器。** 源码里有一个 `ProcessTracker`，本来想像 bash `run_in_background` 那样盯 OS 子进程。没有任何工具调用 `track()`。`TaskExecute` 走 RPC，不走它。

正面定义：**寄生在宿主 Pi 里的任务账本。磁盘（或明确的内存模式）是权威；Widget、提醒、agentId 映射都是派生。子 Agent 是可选的执行后端，不是账本的一部分。**

权威数据源：

| 东西 | 谁说了算 |
|---|---|
| 有哪些任务、状态、依赖边 | `TaskStore` 指向的那份 JSON（或内存 Map） |
| 正在跑的 agentId ↔ taskId | 内存 Map；进程重启靠 `in_progress` + `metadata.agentId` 再挂 |
| Widget 怎么画 | 全局 + 项目 `tasks-config.json`（项目按键覆盖；字形再浅一层合并） |
| 子 Agent 到底跑没跑 | `pi-subagents` 的内存记录；本包只信 RPC 事件 |

## 2. 为什么清单必须和工人分开

正例：模型先 `TaskCreate` 三条，再按依赖 `TaskUpdate` 推进——全程不需要子 Agent。这是账本。  
正例：三条都写了 `agentType`，人开了 autoCascade，一次 `TaskExecute` 把能跑的丢给工人，下游自动接上——账本驱动运行时。  
反例：没有任务表，直接让模型在脑子里记「我做到第几步」——上下文一压就丢，Widget 也没有。  
反例：把任务状态存在子 Agent 记录里——工人一 GC，账本也没了。所以完成结果要写回任务的 `metadata.result`。

职责四行：

- **模型**决定开哪些任务、何时标完成（质量）。
- **本包**保证表结构、依赖边双向、范围、提醒和清理（流程）。
- **JSON 文件**是交接结果。
- **pi-subagents** 只在被问到时干活，不拥有任务 id。

## 3. 先看整体架构，不急着看类名

```text
接入层     七个工具 + /tasks + 上方 Widget + Settings
              收到：增删改、执行、查询
              产出：对存储的一次同步突变，或一次 RPC

账本层     TaskStore
              收到：create / update / list
              产出：原子写盘后的任务数组（tmp + rename + 文件锁）

派生层     Widget / 提醒节奏 / 自动清理 / agentTaskMap
              收到：存储变更或 turn 钩子
              产出：画面、瞬时提醒、若干回合后的删除
                    不反向定义「有哪些任务」

执行适配   （可选）subagents:rpc:ping/spawn/stop/consume
              收到：TaskExecute / TaskOutput / TaskStop
              产出：子 Agent 生命周期事件 → 回写任务状态
```

进程真相和图纸几乎重合，差异是精华：

- 图上的「执行适配」听起来像本包在跑 Agent。实际上本包在宿主事件总线上发消息，工人在**另一个扩展**里。
- 图上的 ProcessTracker 像第二条执行路径。进程上它是死代码：构造了，工具从未 `track()`。

```text
┌─────────────────────────────────────────────┐
│ 宿主 Pi 进程                                  │
│                                             │
│  pi-tasks 工厂                               │
│    ├─ TaskStore ──► .pi/tasks/*.json         │
│    ├─ Widget（aboveEditor）                   │
│    └─ 若 ping 通 pi-subagents v2              │
│         TaskExecute ──rpc──► 那边的管理器      │
└─────────────────────────────────────────────┘
```

## 4. 它主要是一个 Pi 扩展，随宿主起停

证据：`package.json` 的 `pi.extensions` 指向 `./src/index.ts`。peer 为 `@earendil-works/pi-coding-agent` / `pi-tui` `>= 0.80.5`。

工厂在扩展加载时跑一次。`session_start` 的 `new | resume | fork` **复用同一实例**（`getExtensions()` 有缓存）；`startup` / `reload` 会再跑工厂。所以「会话换了」不等于「扩展卸载了」——要自己换存储文件、清 `agentTaskMap`、重置提醒和自动清理。

有没有常驻进程：**没有。** 没有监听端口。没有本包拉起的 child supervisor。

和 `pi-subagents` 的关系：软依赖。发现方式：启动时 ping，协议版本必须是 **2**，也听 `subagents:ready`。5 秒没回就当没有。没有对面时，七个工具里记账四个照常，执行三个走失败文本或空输出。

何时死：宿主进程退出。会话切换不会卸扩展，但会重置映射，并可能把空的 session 任务文件删掉。

## 5. 纵向链路：从「建一条」到「画面上出现」

记账链路。八个节点里，执行是旁路，故意放第 6 章。

```text
工厂就绪 → 选定存储范围 → TaskCreate → Widget → 提醒节奏 → 人工或自动完成 → 自动清理
```

### 5.1 工厂就绪：收到 Pi 加载 → 工具和钩子在，存储可能还是内存

载体：宿主进程，同步。顺手 ping 一次工人扩展。

### 5.2 选定存储范围：收到 session_start / 第一次真正用工具 → 权威文件对上号

载体：宿主进程。默认 `taskScope: "session"`。

| 范围 | 文件在哪 | 含义 |
|---|---|---|
| `memory` | 无 | 关窗口即丢 |
| `session`（默认） | `<cwd>/.pi/tasks/tasks-<sessionId>.json` | 本项目、本会话 |
| `session-global` | 代理目录下按项目哈希再按 session；**若工作区里已经有一份，用工作区那份，不迁移** | 只换位置，不换「按 session 隔离」的语义 |
| `project` | `<cwd>/.pi/tasks/tasks.json` | 跨会话共享 |
| 环境变量 `PI_TASKS` | `off` / 绝对路径 / 相对路径 / `~/.pi/tasks/<name>.json` | 覆盖配置 |

`--no-session` 拿不到 session id，就不落盘。fork 会先快照父表再 `seed` 到新文件，避免两份 session 抢同一条 id 时间线。

id 是 `"1"`、`"2"`… 在**这一份存储**里不复用。新 session 文件从 1 再数。所以切换会话时必须清掉 `agentTaskMap`：旧 Agent 完成事件不能去完成新表里的 `#1`。

### 5.3 TaskCreate：收到 subject+description → 一行 pending

`startNewBatch()` 可能先把上一轮已全部完成的表清掉（见 5.7）。然后 `store.create`。可选 `agentType` 写进 metadata，只是「将来能不能 TaskExecute」的标记，**此刻不 spawn**。

工具描述要求：同一回合里一条任务一次 `TaskCreate`（并行多个 tool call），不要发明批量参数。

完成状态：文件里有了。**不等于**有人在做，也不等于 Widget 的 spinner 在转。

### 5.4 Widget：收到存储变更 → 编辑器上方一列

派生数据。排序默认按 id；`status` 预设是已完成在前（为了叠到顶部藏起来），和 `TaskList` 工具的「pending 在前」相反。这不是 bug。截断发生在折叠完成项之后。字形只来自 JSON 配置，Settings 菜单改不了字形——配置不是可执行文件。

### 5.5 提醒节奏：收到「好几个回合没碰任务工具」→ 一条瞬时提醒

纯回合计数，不是墙钟。空闲 4 回合；有 `in_progress` 时改 2 回合。任务工具会把计数清零。注入发生在 `context` 钩子，是**不落历史**的用户消息，带 `<system-reminder>` 和一份 JSON 回显（最多 10 条，字段会剥换行和嵌套 reminder 标签）。

0.7.0 之后：**不再改 tool_result 正文。** `tool_result` 只把「该提醒了」置位。不要在工具输出里找 reminder。

完成 ≠ 模型看见：提醒是瞬时的。下回合不一定还在。

### 5.6 完成：收到 TaskUpdate completed，或工人事件

人工路径：模型把 status 打成 `completed` / `deleted`（deleted 不落盘，是删行并剪边）。  
工人路径：见第 6 章。

依赖边双向：`addBlocks` / `addBlockedBy` 两侧都写。环、指向不存在的 id、自己指向自己：**照样存**，工具回复里给警告。没有图校验事务。这是当前可靠性边界。

### 5.7 自动清理：收到若干 `turn_start` → 可能删掉已完成行

延迟 4 回合。三种模式：`never` / `on_list_complete`（默认，整表都完成后才开始计） / `on_task_complete`（单个完成就计）。

`agent_settled` 会**冻住**倒计时，避免 Agent 刚停手就把表擦了、下一句用户话看不见成果。下一次 `TaskCreate` 若上一轮已经结束且全部完成，会立刻清完再开新批次。

新会话若打开就是「全完成」且不是 resume/fork/reload：直接不展示那批陈旧完成项。空 session 文件会被 unlink。

判定句：**任务已 completed，只证明账本改了。还在不在 Widget 里、还在不在文件里，取决于清理模式和回合计数，不取决于墙钟。**

## 6. 第二条链路：TaskExecute 去问工人

前提：`subagentsAvailable === true`，协议 v2。

```text
TaskExecute(task_ids)
  → 每条必须是 pending、带 agentType、阻塞它的任务都已完成
  → RPC spawn（可附 additional_context / model / max_turns）
  → 成功：in_progress + metadata.agentId + owner + 内存映射
  → 失败：回到 pending，这条跳过，其它 id 继续
  → 子 Agent 结束事件：
       completed → 写 metadata.result，尝试 cascade
       failed 且 stopped → 当完成（部分结果）
       其它 failed → pending + lastError，不 cascade
```

`TaskOutput` 默认挡住等。若等到的时候映射已经没了、任务也不再 `in_progress`，发 `consume` 让工人不要再 followUp 父对话——避免「任务工具已经把结果给了模型，父对话又被 nudge 一次」。

`TaskStop` 对工人发 stop；若走 ProcessTracker 分支且从没 `track()` 过，会抛「没有在跑的后台进程」。那是死路径，不是你的任务没停掉。

### autoCascade

默认 **false**。还要有一次成功的 `TaskExecute` 把 cascade 配置留在内存里。之后某条完成，解阻的、带 `agentType` 的 pending 下游会被自动 spawn，prompt 里带上游结果（截到 4000 字）。spawn 失败：下游回到 pending。

所以：完成一条任务 **不能** 推导出下游已经在跑。先看开关，再看这次会话有没有执行过 TaskExecute。

### 重挂

`session_start` / `before_agent_start`：对当前存储身份只做一次。只重挂 `in_progress` 且 `metadata.agentId` 是字符串的行。pending 上残留的 agentId **不**重挂——避免把已经重置的工作救活。

## 7. 边界、误区

| 词 A | 词 B | 不要混 |
|---|---|---|
| 本包 TaskCreate | Pi 内置任务工具 | 没有内置；加载了本包就是它 |
| 任务 JSON | 子 Agent 记录 | 清单权威在本包；工人记录进不了下一进程 |
| TaskExecute | ProcessTracker | 执行走 RPC；Tracker 未被工具调用 |
| session | session-global | 隔离语义相同，只是文件目录不同 |
| TaskList 顺序 | Widget 顺序 | 工具 pending 在前；Widget 默认按 id，`status` 预设 completed 在前 |
| 提醒 | 历史消息 | 提醒不落盘 |
| Settings | 全局 config | 菜单只写项目 `.pi/tasks-config.json` |
| auto-clear | setTimeout | 数的是 turn_start，Agent 停手会冻结 |
| `/tasks` | 七个工具 | 人入口 vs 模型入口，同一份存储 |

README 有一处和代码不一致，以代码为准：`TaskGet` 的 `blockedBy` 只返回**尚未完成**的阻塞者（和 `TaskList` 一样），`blocks` 不过滤。README 若写「所有边含已完成阻塞」是过时描述。

`task-store.ts` 文件头若仍写「默认内存 / `PI_TASK_LIST_ID`」，同样过时。真实默认是文件 session 范围，覆盖变量是 `PI_TASKS`。

常见误区：

- **「TaskExecute 会在本包里 createAgentSession。」错。** 正：事件 RPC。
- **「没装 pi-subagents 就完全不能用。」错。** 正：账本四件套可用。
- **「Settings 改的是我所有项目的默认。」错。** 正：只写当前项目；跟着人走的默认靠手改全局 JSON。
- **「依赖成环会拒绝写入。」错。** 正：写入 + 警告。
- **「PI_TASKS 指向的文件空了会像 session 文件一样被回收。」错。** 正：回收只针对 session-global 目录约定。

## 8. 失败形态与排错

**任务建得成，Widget 没有**  
看 `taskScope` 是不是切到了另一份文件；fork/新会话 id 变了。不要先怀疑渲染。Widget 渲染抛错会吞成空帧，避免拖垮 TUI——那是最后才查的。

**TaskExecute 返回文本错误，状态仍是 pending**  
1. 对面扩展在不在。  
2. 协议是不是 2。  
3. ping 是否 5 秒超时。  
4. 这条是不是 pending、有没有 `agentType`、阻塞者清没清。  
不要先怀疑任务 JSON 损坏（损坏时 load 会忽略坏文件、保住内存态）。

**子 Agent 明明跑完了，任务还 in_progress**  
映射丢了：进程中途重载且重挂条件不满足（例如状态已经被改回 pending）。看 `metadata.agentId` 还在不在、状态是不是 `in_progress`。

**父对话被 nudge 了一次，TaskOutput 又把全文给了模型**  
consume 没发出去。对 `pi-subagents` 来说这是 `resultConsumed` 闸门没合上，见[看懂 pi-subagents](./看懂%20pi-subagents.md) 第 6.8 节。

**完成后任务「过一会儿」还在，或「一停手」就没了**  
前者：默认要等整表完成再数 4 个 turn_start，且 `agent_settled` 会冻结。后者：`on_task_complete` + 又开了新批次。不要用墙钟估。

**TaskStop 抛 No running background process**  
走了 ProcessTracker 死路径：没有工人映射，也从未 `track()`。先看任务上有没有 agentId，以及对面还认不认这个 id。

**两个会话的 #1 串了**  
切换时没清 `agentTaskMap`，或两份存储共用了路径。session 范围必须带 session id。

## 9. 总结

1. **这是任务账本扩展，不是 Pi 内置，不是工人。** 工人是可选的 `pi-subagents`。
2. **权威在 TaskStore 的文件（或明确的内存模式）。** Widget / 提醒 / 映射都是派生。
3. **记账和执行两条链路可独立成败。** 没工人时账本仍完整。
4. **提醒不写历史；自动清理数回合，不数分钟；cascade 默认关。**
5. **ProcessTracker 不是 TaskExecute 的实现。** 改执行路径去 RPC，不要去复活 Tracker，除非 Pi bash 真有了后台进程原语。

如果只记一条完整主线：

```text
TaskCreate → 当前范围的 JSON 多一行 pending
  → Widget 画派生视图
  → （可选）TaskExecute RPC → 子 Agent → 回写 completed
  → （可选）cascade 下游
  → 提醒按回合瞬时注入
  → 再若干 turn_start 后按模式清掉已完成
  → 宿主退出：内存映射消失；文件范围的表还在
```

## 10. 深入通道：按调用链读

1. `package.json` + `src/index.ts` 工厂到 `registerTool` 之前  
   怎么接到 Pi、何时 ping 工人、`PROTOCOL_VERSION`。

2. `src/types.ts` + `src/task-store.ts` + `src/task-paths.ts`  
   行结构、双向边、锁、原子写、session vs session-global。看完应能回答「id 何时从 1 再数」。

3. `src/index.ts` 七个 `execute`  
   模型入口。重点：TaskCreate 开批次、TaskExecute 的跳过条件、TaskGet 过滤 blockedBy、TaskOutput 的 consume、TaskStop 的两条分支。

4. `src/index.ts` 的 `session_start` / `reattachAgents` / 完成事件 / cascade  
   会话换文件、fork seed、重挂条件、失败不 cascade。

5. `src/reminder-cadence.ts` + `src/auto-clear.ts`  
   两个纯回合状态机。和墙钟无关。看 `onRunEnded` 冻结。

6. `src/tasks-config.ts` + `src/ui/settings-menu.ts` + `src/ui/task-widget.ts` + `src/task-sort.ts` + `src/task-glyphs.ts`  
   人看见什么、配置合并、菜单只写项目文件。

7. `src/process-tracker.ts` + `test/task-output-stop.test.ts` 文件头  
   确认死路径，避免二次开发走错。

8. `test/subagent-integration.test.ts` + `test/subagent-result-consumption.test.ts` + `test/auto-cascade.test.ts`  
   和工人之间的合同。改 RPC 先跑这组。

本仓库另有交互课：[pi-tasks-course](./pi-tasks-course/)。冲突以源码为准。

### 参考资料

- https://github.com/tintinweb/pi-tasks
- https://github.com/tintinweb/pi-tasks/blob/master/CUSTOMIZING.md
- https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md
- https://pi.dev
