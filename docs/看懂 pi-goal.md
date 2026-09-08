# 看懂 pi-goal：把长任务钉在会话上，而不是靠模型自己记得

> 本文面向第一次接触 `@code-yeongyu/pi-goal`、已经知道 Pi 会加载扩展、会跑多回合 Agent 的读者。重点是：它解决什么问题、状态存在哪、谁有权改状态、一条目标怎样从「设下」走到「完成或卡住」。
>
> **本文定位：小项目、二次开发深度。** 稳定认知放在职责边界、权限分离与数据流上。命令文案、TUI 措辞、prompt 全文属于易变细节。
>
> **先分清同名包：** 本仓库还有 `@narumiruna/pi-goal`。那是另一份实现。本文只讲 `@code-yeongyu/pi-goal`（npm 包名 `pi-goal`，版本 `0.3.0`）。
>
> 源码基线：工作区 HEAD `6f1c21c`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游：[code-yeongyu/pi-goal](https://github.com/code-yeongyu/pi-goal)。宿主扩展 API：[pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)。
>
> 同目录另有一份偏函数级的走读：[`docs/@code-yeongyu pi-goal.md`](./@code-yeongyu%20pi-goal.md)。和本文互补：本文先建立运行图，那份再对着调用链下钻。

## 1. TLDR：它做的事情可以压缩成三条链路

普通对话里，模型「记得要做完登录」只存在于上下文窗口。窗口一压缩、会话一重开，目标就蒸发了。`pi-goal` 把目标做成**会话级实体**：写入磁盘，画在页脚，并在每个空闲回合偷偷塞一条「继续干」的隐藏消息。

```text
设目标：
用户 /goal <objective>  或  模型 create_goal
→ 校验长度、写入会话目录里的 JSON
→ 页脚变成 Pursuing goal
→ 若当前空闲，立刻塞一条隐藏 continuation，触发下一回合

续跑：
上一回合结束且目标仍是 active、没有排队消息
→ 再塞一条隐藏 continuation（用户看不见，模型看得见）
→ 模型继续干活；扩展在旁累计 token 和秒数

收束：
模型 update_goal(complete | blocked)
或用户 /goal pause|resume|clear
或回合被 abort → 记成 blocked（原因写死为 user interrupted the turn）
→ 页脚更新；complete / blocked / paused 都不再自动续跑
```

所以它不是：

- 不是任务队列、不是 job runner（没有 worker 池，没有跨会话调度）
- 不是 plan-mode（不限制工具集，不进入「只能规划不能改文件」的状态机）
- 不是记忆系统（不总结对话，不检索旧目标；权威状态就是那一份 JSON）
- 不是模型可以随意 pause / resume 的开关（这两步只留给用户或系统）

正面定义：**它是寄生在 Pi 宿主里的扩展。判断「目标是否真的做完」的是模型（被 prompt 勒令先审计证据）；扩展负责把目标存住、续跑、记账，并挡住模型去 pause。**

权威数据源：`goalFilePath` 指向的那份 `{ version: 1, goal }` JSON。页脚、工具返回值、continuation 文本都是派生视图。JSONL 历史不是当前目标，只在「用 `create_goal` 覆盖一个已 complete 的旧目标」时追加。

## 2. 为什么需要一个独立的 Goal 实体

正例：用户说「把登录做成，测过再停」。这不是单回合能保证的。需要跨很多 tool call、跨用户插入的闲聊、跨会话重开，仍然指向同一条 objective。

反例：用户只是问「这段代码什么意思」。不该为此建目标。`create_goal` 的工具描述写明：只有用户或系统明确要求时才建，禁止从普通任务里「推断」出一个 goal。

所以职责这样切：

| 角色 | 负责 | 不负责 |
|---|---|---|
| 用户 | 提出 objective；pause / resume / clear；会话恢复时决定要不要继续 paused 目标 | 不负责审计「是否真做完」 |
| 模型 | 干活；在证据齐了以后 `complete`；同一阻碍连续出现后 `blocked` | 不能 pause / resume / clear |
| 扩展 | 存盘、页脚、隐藏续跑、用量累加、合法状态转移 | 不判断代码是否写对 |
| 隐藏 continuation | 把 objective 当**不可信用户数据**塞回上下文，并列出审计清单 | 不提高 objective 的指令优先级（有 XML 转义 + `<untrusted_objective>` 包装） |

`tokenBudget` 字段可以出现在 JSON 里，但 **0.3.0 不按预算停跑**。CHANGELOG 写的是 inert、为了线协议兼容。不要从字段名推导出「超预算会自动 complete / blocked」。

## 3. 先看整体架构，不急着看类名

先看职责图，下一章揭穿进程真相。两者大部分重合，差异是：图上的「生命周期层」不是独立进程，只是挂在宿主事件上的回调。

```text
┌──────────────────────────────────────────┐
│ 宿主层  Pi 进程                            │
│ 命令、工具、session_* / agent_* 事件        │
└──────────────┬──────────────┬────────────┘
               │              │
┌──────────────▼────┐  ┌──────▼────────────┐
│ 命令层 /goal       │  │ 工具层             │
│ show/pause/resume  │  │ create_goal        │
│ clear/setObjective │  │ update_goal        │
└──────────────┬────┘  │ get_goal           │
               │       └──────┬────────────┘
               └───────┬──────┘
                       ▼
┌──────────────────────────────────────────┐
│ 生命周期层（同一进程里的事件回调）          │
│ 记账、中断变 blocked、排队隐藏 continuation │
└──────────────────────┬───────────────────┘
                       ▼
┌──────────────────────────────────────────┐
│ 存储层  每线程一份 JSON                    │
│ 可选 history.jsonl、超长 objective 旁路文件 │
└──────────────────────────────────────────┘
```

状态机（谁允许哪条边）比类名重要：

```text
                    用户 pause
          ┌─────────────────────────┐
          │                         ▼
       active  ←──── 用户 resume ── paused
          │  \
          │   \ 模型 complete
          │    \                    complete  ← 模型也可从 blocked 点 complete
          │     ───────────────►
          │
          └── 模型 blocked ──► blocked
                 ▲
                 └── 用户下一句真实提问时，扩展用 source="user" 自动拉回 active
                     （隐藏 continuation 不会走这条恢复）
```

同状态转移到自己是合法的（幂等）。模型不能 pause，用户不能直接点 complete——complete / blocked 是模型工具的边；pause / resume / 从 blocked 拉回 active 是用户（或扩展冒充 user source）的边。

## 4. 实际怎样运行：寄生扩展 + 会话目录里的 JSON

它是 **Pi 扩展**，不是 daemon。

证据：`package.json` 的 `pi.extensions: ["./src/index.ts"]`；入口 `goalExtension(pi)` 只做三件事：注册生命周期、注册工具、注册 `/goal`。没有监听端口，没有定时器自己拉起 Agent。

「续跑」看起来像后台，其实是：

```text
扩展调用 pi.sendMessage(
  { customType: "pi-goal-continuation", display: false, content: ... },
  { triggerTurn: true, deliverAs: "followUp" }
)
```

这是宿主提供的发消息 API。隐藏消息进上下文，并触发新一轮模型回合。**没有第二个进程。** 崩溃/重启语义跟 Pi 会话走：Pi 挂了，续跑就停；下次 `session_start` 若目标仍是 `active` 且空闲，会再塞一条 continuation。

目标文件落在哪（`src/index.ts` 的 `goalStoreRef`）：

| 启动方式 | 目录 |
|---|---|
| 有持久化会话 | `<sessionDir>/extensions/pi-goal/` |
| 没有 session 文件 | `$PI_CODING_AGENT_DIR/extensions/pi-goal/no-session/<cwd 的 sha256 前 24 位>/` |

`PI_CODING_AGENT_DIR` 缺省是 `~/.pi/agent`。文件名是 URL 编码后的 `threadId`（也就是 `sessionManager.getSessionId()`）：

- `<id>.json` — 当前目标（权威）
- `<id>.history.jsonl` — 被 `create_goal` 归档的旧 complete 目标
- `<id>.objective-full.txt` — 超过 4000 个 code point 时的全文旁路

**没有会话文件，不等于没有目标。** 无会话回退按 cwd 哈希分桶，所以在同一个目录反复 `pi` 无会话启动，仍可能读到上次的 goal。换目录就是另一个桶。

和宿主的边界：

```text
Pi 宿主进程
 ├─ pi-goal 模块（事件回调 + 工具 + 命令）
 └─ 磁盘上的 JSON（权威状态；进程退出后还在）
```

页脚是 `ctx.ui.setStatus("goal", ...)`。没有 UI 的上下文（`hasUI === false`）直接跳过，不崩。会话被替换导致 ctx 过期时，页脚更新吞掉「stale extension ctx」错误，其它错误仍抛。

## 5. 权限分离：用户能改什么，模型能改什么

这是本项目最值得先钉死的边界。源码用 `GoalUpdateSource = "model" | "user"` 卡住转移表。

| 动作 | 用户 `/goal` | 模型工具 | 扩展自己 |
|---|---|---|---|
| 新建 / 改写 objective | `/goal <文本>`（已有目标会确认替换） | `create_goal`（未完成目标存在则失败；已 complete 则归档再新建） | 否 |
| 查看 | `/goal` | `get_goal` | `session_start` 时读一次画页脚 |
| pause | `/goal pause` | 非法 | 否 |
| resume paused | `/goal resume`；会话恢复时弹选择 | 非法 | 否（只提示，选择权在用户） |
| complete | 不能 | `update_goal({ status: "complete" })` | 否 |
| blocked | 不能直接设 | `update_goal({ status: "blocked", reason })` | 回合 `abort` 时用写死原因走模型这条边 |
| 从 blocked 回到 active | 下一句**真实用户提问**时自动（`before_agent_start`，source=`user`） | 非法 | 是，但挂在「用户即将开口」上 |
| clear | `/goal clear` | 不能 | 否 |

模型侧硬规则（工具描述 + `transitions.ts` 双重执行）：

- `blocked` 必须有非空 `reason`；`complete` 禁止带 `reason`
- 工具文案要求：同一阻碍至少连续 3 个 goal 回合才许 blocked；resume 之后重新计次。**这是 prompt 约束，扩展不计数。** 模型不守，磁盘照样会变成 blocked
- 不要因为难、慢、不确定就 blocked

SKILL.md 目前仍写「`update_goal` 只接受 `complete`」「`create_goal` 带 `token_budget`」。以 `src/` 和 CHANGELOG 0.3.0 为准：工具接受 `complete | blocked`，`create_goal` 只有 `objective`。这是文档漂移，不是第二种实现。

## 6. 纵向链路一：从 `/goal` 到隐藏续跑

一条真实输入：用户键入 `/goal 实现登录`。

```text
命令层 → 存储层 → 页脚层 → 续跑层 →（之后每个回合）记账层
```

### 6.1 命令层：收到原始参数字符串 → 解析 kind → 产出一次动作

载体：Pi 宿主进程，用户命令回调。同步。

`parseGoalCommand` 只认 trim 后的整串：空 = show，`pause` / `resume` / `clear` 大小写不敏感，其余全部当 objective。没有子命令解析器，所以 `/goal pause now` 会被当成一句新 objective。

已有目标时，有 UI 会 `select`「Replace / Cancel」。无 UI 默认替换。

### 6.2 存储层：收到 objective → 校验、截断、写 JSON → 产出 `Goal`

载体：同一进程的文件系统调用。同步。

- 空 objective 抛错，不写盘
- 超过 4000 个 Unicode code point：就近空白截断，追加「全文在某个文件」标记，并把原文写到 `objective-full.txt`
- 当前已有未完成目标：命令路径走 `updateGoal`（改 objective，必要时换新 id、用量清零）；工具路径 `create_goal` 则直接失败
- `writeGoal` 是 `mkdir` + 直接 `writeFile`。**不是 temp + rename。** 写到一半掉电，可能留下半截 JSON，下次 `readGoal` 会抛 `InvalidGoalStoreError`。这是当前可靠性边界

### 6.3 页脚层：收到 Goal → `setStatus` → 用户看见 Pursuing goal

同步、尽力而为。这不是权威状态。JSON 写成功而页脚失败，目标仍然在。

### 6.4 续跑层：收到「现在空闲且 active」→ 隐藏 followUp → 触发新回合

判定在 `continuation.ts`：`status === "active"` 且 `isIdle()` 且没有 pending 消息。

`session_start`、`/goal` 设目标、`/goal resume`、以及每个 `agent_end` 之后，只要判定为真，就再塞一条。paused / blocked / complete 都不会。

**排队成功 ≠ 模型已经开始干。** 只证明宿主接受了一条隐藏消息并 `triggerTurn`。若随后的 provider 准入把这次跑拒绝了，目标仍是 active，JSON 不变。下一次真正的用户提问或下一次成功的 `agent_end` 会再试。

paused 目标在 `session_start` 且 `reason === "resume"` 时，有 UI 会问要不要 Resume。选否就保持 paused，不续跑。

### 6.5 记账层：收到回合里的 assistant usage → 累加 tokensUsed / timeUsedSeconds

载体：同一进程。`agent_start` 开始计时并 `TurnUsageTracker.reset()`；`message_end` 把该条 assistant 的 usage 记入 pending；`agent_end` / 中途 `get_goal` / pause / clear 时刷进 JSON。

`tokensUsed` 只加 `input + output`，**不加 cacheRead / cacheWrite**。时间是墙钟秒，`Math.trunc`。`updatedAt` 至少比上一次大 1 秒，避免同一秒内多次写分不清顺序。

`session_shutdown` 若还在记账，会再刷一次 active 用量。

判定句：**页脚上的秒数是派生值；JSON 里的 `timeUsedSeconds` 才是落下的账。回合中途看页脚，可能还没加上这一回合。** `get_goal` 会先 `accountCurrentAgentTurn(..., "active")` 再返回，所以模型读到的比页脚更接近当前。

## 7. 纵向链路二：完成、阻塞、中断

这条链路和续跑可独立成败：续跑失败（没排上队）不改变 JSON；complete 成功会立刻停止续跑。

```text
干活中的 active
 → 模型 update_goal(complete)     → complete，停续跑，保留用量
 → 模型 update_goal(blocked, r)   → blocked，停续跑；下次真实用户提问自动 resume
 → ctx.signal.aborted             → 先记账，再 blocked(reason=user interrupted the turn)，且本回合不续跑
```

### 7.1 complete

模型必须先按 continuation 里的审计清单对过证据。扩展**不验证**证据，只验证状态转移合法。`accountCurrentAgentTurn` 在改状态前先把本回合账记上，mode 随后切到 `activeOrComplete`，这样 complete 当下那一回合的用量不会丢。

完成了的目标还在 JSON 里，页脚写 `Goal achieved`。它不是「删除」。要开新目标：用户 `/goal 新文本`（替换），或模型 `create_goal`（此时才会把旧 complete 追加进 history.jsonl）。

注意不对称：**`/goal` 替换不会写 history。** 只有 `create_goal` 在旧目标已 complete 时 `archiveGoal`。用户路径覆盖旧目标，历史里可能没有那一条。

### 7.2 blocked

模型带 reason 调用。扩展记下 `blockedReason` / `blockedAt`，清掉 `lastStartedAt`。

恢复不是模型的事，也不是 continuation 的事。注释写得很清楚：挂在 `before_agent_start`，因为这个事件只对**真实用户提问**触发，并且发生在宿主最后的 provider 准入之前。若把恢复推迟到 `agent_start`，一次被拒绝的 run 可能把「该恢复了」的脏标记漏到后面那次由 continuation 拉起的回合——而 continuation 不应该替用户解除 blocked。

因此：

- 用户打了一句新话 → blocked 变 active，再开跑
- 隐藏 continuation → 不会解除 blocked
- 用户什么都不说 → 一直 blocked

### 7.3 中断

`agent_end` 看 `ctx.signal.aborted`。为 true 且目标仍 active，就用模型那条边写成 blocked，原因写死 `user interrupted the turn`。

README 自己承认：公开扩展 API 没有 abort 来源字段，**系统 abort 也可能被标成用户打断**。这是当前语义边界，不是 bug 报告里的「偶发」。

中断后本回合抑制 continuation。下一次真实用户提问走 7.2 的自动 resume。

## 8. 存储失败与用量模式

`readGoal`：文件不存在 → `null`（当成没目标，不抛）。JSON 坏了或 `version !== 1` → 抛，命令层 catch 后 `notify` 错误。没有自动修复、没有备份。

`accountGoalUsage` 的 mode 决定「状态已经变了还能不能把账加上去」：

| mode | 何时用 | 还记账的状态 |
|---|---|---|
| `active` | 普通回合结束、pause/clear 前、get_goal | 仅 active |
| `activeOrBlocked` | 本回合刚被标 blocked | active 或 blocked |
| `activeOrComplete` | 本回合刚被标 complete | active 或 complete |

另有 `expectedGoalId`：回合开始记在内存里的 id 必须和磁盘上的 id 一致，否则不加账。防止你在回合中途换了目标，却把旧回合的 token 记到新目标上。

可靠性表：

| 失败位置 | JSON 变了吗 | 页脚 | 续跑 | 下次 |
|---|---|---|---|---|
| 校验 objective 失败 | 否 | 否 | 否 | 改文本再试 |
| `writeFile` 中途失败 | 可能半截（无事务） | 不一定 | 不一定 | 可能要手动修/删 JSON |
| 隐藏消息被宿主拒 | 目标仍是 active | 已更新 | 没排上 | 下一次 idle/agent_end 再试 |
| abort 被误判 | 变成 blocked | Goal blocked | 抑制 | 用户再开口会自动 resume |
| 旧 complete 被 `/goal` 覆盖 | 被新目标替换，**无** jsonl | 新目标 | 按新状态 | 旧目标可能再也找不到 |

## 9. 常见误区与排错

### 9.1 误区

**「Goal 是跨项目全局的。」错。** 正：按 session id（无会话则 cwd 哈希）隔离。换会话就是另一个目标槽。

**「模型宣布完成，扩展会去跑测试核对。」错。** 正：扩展只改状态。审计清单是 prompt，不是验证器。

**「blocked 会自己找人来解。」错。** 正：等真实用户下一句。continuation 不会解。

**「pause 和 blocked 差不多。」错。** 正：pause 是用户主动停下，resume 也要用户；blocked 是模型或中断写入，用户一开口就自动回到 active。

**「`tokenBudget` 会让它停。」错。** 正：0.3.0 存了不用。

**「这就是 `@narumiruna/pi-goal`。」错。** 正：同名不同源，生命周期和工具集合不要混着读。

### 9.2 症状式排错

**页脚一直 Pursuing goal，但模型在闲聊。** 先看 JSON 是否 active、这一回合是不是用户消息而不是 continuation、`hasPendingMessages` 是否挡住了排队。不要先怀疑 store 坏了。

**目标 blocked 了，发 `/goal` 空命令也没恢复。** show 不恢复。说一句真实任务，或等 `before_agent_start`。不要用 continuation 硬撬。

**刚 complete 又被续跑。** 查 `update_goal` 有没有真的成功写回；若工具报错，状态可能仍是 active，`agent_end` 就会再排队。

**用量对不上账单。** 只计 input+output；cache 不计。跨目标替换会清零。不要拿供应商控制台的 total 直接对。

**无会话启动却读到旧目标。** 查 `no-session/<cwd-hash>`。换工作目录或清那个文件夹。

**一读目标就报 invalid / unsupported version。** JSON 损坏或将来的 version≠1。没有迁移器。从 history.jsonl（如果有）或备份恢复；否则删 `<id>.json`。

## 10. 总结

可独立验证的稳定事实：

1. **权威状态是会话目录里的那份 JSON。** 页脚和 continuation 都是派生的。
2. **pause / resume / clear 是用户的；complete / blocked 是模型的。** 扩展在用户下一句真实提问时，才能把 blocked 拉回 active。
3. **续跑靠宿主的隐藏 followUp，不是 daemon。** 排队成功只证明消息被收下，不证明模型已经跑完审计。
4. **complete 已写入 ≠ 旧目标进入历史。** 只有 `create_goal` 覆盖 complete 时才追加 jsonl；`/goal` 替换不归档。
5. **当前没有包住写入的总事务，也没有 abort 来源。** 半截 JSON 和「系统 abort 被标成用户打断」都是公开边界。

如果只记一条完整主线：

```text
用户或模型设下 objective
→ 写入 <session>/extensions/pi-goal/<threadId>.json
→ 空闲且 active 时塞隐藏 continuation，触发下一回合
→ 每回合累加 input+output 与秒数
→ 模型在证据齐后 complete；或 blocked / 用户打断
→ blocked 等用户再开口才恢复；paused 等用户明确 resume
→ 没有 worker。Pi 退出，续跑停；JSON 留在磁盘
```

## 11. 深入通道：按事件走，不要按文件名散读

1. `src/index.ts`：扩展怎么把「当前会话」变成 `GoalStoreRef`？无会话回退是哪条路径？
2. `src/goal/types.ts` + `transitions.ts`：四种状态、谁允许哪条边。看完应能默写第 3 章那张图。
3. `src/goal/command.ts` + `command-registration.ts`：`/goal` 五种动作、替换确认、pause 前先记账。
4. `src/goal/tool-registration.ts`：模型只能 complete / blocked；`create_goal` 对未完成目标失败。
5. `src/goal/lifecycle.ts`：`session_start` / `before_agent_start` / `agent_start` / `message_end` / `agent_end` / `session_shutdown` 各自改什么。**这是主文件。**
6. `src/goal/continuation.ts` + `prompt.ts`：何时排队；objective 如何被当成不可信数据。
7. `src/goal/store.ts` + `validation.ts`：JSON 形状、截断、归档不对称、非原子写入、记账 mode。
8. `src/goal/turn-usage.ts`：pending vs flushed，为什么 cache 不加进 `tokensUsed`。
9. `src/goal/ui.ts` + `format.ts`：页脚文案与工具 JSON 是两套视图。
10. `SKILL.md`：只当「希望模型遵守的话术」，与 0.3.0 源码冲突时信源码。

测试合同：`test/extension.test.ts`（事件拼起来）、`test/continuation.test.ts`、`test/store.test.ts`、`test/command.test.ts`。改状态机先跑这四个。

本地冒烟：`pi -e ./src/index.ts`，`/goal 做一件需要多回合的事`，看页脚和是否自动再开跑；`/goal pause` 后页脚应提示 resume。

## 参考资料

- [pi-goal README](https://github.com/code-yeongyu/pi-goal)
- [本仓库函数级走读](./@code-yeongyu%20pi-goal.md)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- 不要与 [`@narumiruna/pi-goal`](../@narumiruna/pi-goal) 或 [`docs/@narumitw/07-pi-goal.md`](./@narumitw/07-pi-goal.md) 混读
