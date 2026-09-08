# 看懂 pi-subagents：同一进程里的多 Agent 运行时

> 本文面向已经会用 Pi、听过「子 Agent / 后台任务」但还没分清「子进程、子会话、工作流脚本」的读者。本文定位：**二次开发深度**。先把几个容易撞车的实体钉死，再讲运行形态和一条真实的 spawn 链路。
>
> 源码基线：本仓库 `@tintinweb/pi-subagents`，包版本 `0.19.0`（CHANGELOG 2026-08-25），peer 要求 Pi `>= 0.84.0`。父仓库 HEAD `6f1c21c`（2026-09-08）。这是 vendored 快照。字段名、默认并发、工具描述会变；**稳定认知放在：谁拥有生命周期、记录存在哪、子 Agent 是不是进程、工作流线程在干什么。**
>
> 权威源：[上游 README](https://github.com/tintinweb/pi-subagents)、[docs/rpc.md](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md)、[docs/workflows.md](https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md)。同系列：[看懂 pi-schedule-prompt](./看懂%20pi-schedule-prompt.md)、[看懂 pi-tasks](./看懂%20pi-tasks.md)。

## 1. TLDR：它不是「再开一个 pi」

Pi 的主会话一次只能当一个 Agent。`pi-subagents` 让宿主模型按 Claude Code 的姿势再拉起若干**隔离会话**：自己的工具、系统提示、模型、思考级别；默认为后台跑，也可以挡住等结果；中途可以 steer，跑完可以按 handle 恢复。编排不该即兴时，把一段确定性的 JavaScript 交给 `SubagentWorkflow`（工作流工具）。

它做的事情可以压缩成三条链路：

```text
即兴委派：
宿主模型调 Agent 工具
  → 解析类型 / 模型 / 是否后台
  → 在本进程登记一条运行记录
  → 同进程 createAgentSession + prompt
  → 结束后写记录，必要时 followUp 叫醒宿主

确定性编排：
宿主调 SubagentWorkflow
  → 工作线程里跑 JS（agent/parallel/pipeline）
  → 每次 agent() 回到宿主进程去 spawn
  → 脚本结束，工具拿回结构化结果

定时再跑：
Agent({ schedule })
  → 写入本会话的 schedules JSON
  → 到点在本进程再 spawn 一次（绕过后台并发队列）
```

所以它不是：

- **不是守护进程，不是独立 CLI。** 没有 `bin`，没有 `main`。入口是 `"pi.extensions": ["./src/index.ts"]`。
- **不是子进程农场。** 子 Agent 是同进程里的 `AgentSession`（Pi SDK 的会话对象）。只有工作流**脚本**才用 `worker_threads`，而且那条线程是为了能杀掉脚本，不是为了跑模型。
- **不是 pi-schedule-prompt。** 本包有自己的调度器和 `<cwd>/.pi/subagent-schedules/<sessionId>.json`。血缘是 pi-cron-schedule 的引擎 + pi-chonky-tasks 的存储，和 Heartbeat 扩展无关。
- **不是任务清单。** 任务列表是 `pi-tasks` 的职责。本包经进程内事件总线给它提供 spawn / stop / consume。
- **不是仓库根上那份 `AGENTS.md`。** 贡献者规范 ≠ Agent 类型。类型文件在 `~/.pi/agent/agents/*.md` 和项目 `.pi/agents/*.md`。

正面定义：**寄生在宿主 Pi 进程里的多 Agent 运行时。内存里的运行记录是这次会话的真相；磁盘上的会话文件、调度 JSON、MEMORY.md 才是跨回合能留下的东西。**

权威数据源：

| 东西 | 谁说了算 | 进程一关还在吗 |
|---|---|---|
| 正在跑谁、状态、结果预览 | 内存里的运行记录表 | 不在 |
| 子会话全文（若开启持久化） | Pi 的 session 文件 | 在，可用 handle / `/resume` 再打开 |
| 定时作业 | `<cwd>/.pi/subagent-schedules/<sessionId>.json` | 在，跟 session id；`/new` 会换 |
| 自定义类型 | 三级 markdown | 在 |
| 跨扩展 spawn | 进程内 `pi.events`，协议 v2 | 不在，过不了进程边界 |

## 2. 先分清四个实体，再往下看

大中型扩展最容易在这里迷路。四个词看起来都叫「agent」，不是同一个东西。

```text
Agent 类型（Explore / Plan / general-purpose / 你写的 .md）
  └─ 一次运行（内存记录：id、handle、status、result…）
        ├─ 子会话 AgentSession（真正发 LLM、调工具）
        ├─ 可选：git worktree 副本
        └─ 可选：JSONL 输出、MEMORY.md

工作流脚本（另一条运行时）
  └─ Worker 线程 + vm
        └─ 多次 agent() → 仍创建上面那种「一次运行」
```

- **类型**回答「用谁的提示词和工具白名单」。内置三个：`general-purpose`、`Explore`、`Plan`。同名 markdown 可以覆盖它们。
- **一次运行**回答「现在这一趟走到哪了」。状态机：`queued | running | completed | steered | aborted | stopped | error`。这张表**不写盘**。
- **子会话**回答「模型上下文在哪」。可内存、可落成 Pi session 文件。
- **工作流**回答「多趟之间的控制流谁说了算」。模型即兴用 `Agent`；脚本用 `agent()` / `parallel()` / `pipeline()`。

不要把类型和一次运行混在一起理解。`Explore` 可以同时活着三条运行；三条运行可以是三个 handle。

## 3. 为什么宿主自己搞不定

正例：主会话在写代码，需要有人只读地扫一遍认证相关文件——拉一个 `Explore`，默认后台，主会话继续。  
正例：审查要扇出三个独立视角再汇总——工作流 `parallel` 三个 `agent()`，结果在脚本里汇合。  
反例：只是想列一个 todo、标完成——那是 `pi-tasks`，不要为这个 spawn。  
反例：想「每天 9 点往当前对话塞一句」——那是 `pi-schedule-prompt` 的内联路径，不是本包。

本包存在的理由是 **运行时隔离 + 生命周期**，不是又一个提示词模板集。类型文件只是策略；真正贵的是：并发池、子会话的工具剥离、完成通知去重、会话切换时怎么拆。

## 4. 先看整体架构，不急着看类名

文档视角：

```text
接入层     工具 Agent / get_subagent_result / steer_subagent / SubagentWorkflow
           命令 /agents    Widget / Fleet    @handle 提及    跨扩展 RPC
              收到：一次委派或一次查询
              产出：调用运行时，或读记录

解析层     类型注册表 + 调用配置合并
              收到：subagent_type、model、isolation、schedule、resume
              产出：一次可启动的调用描述；schedule 则只登记作业

运行时     每个根会话一个管理器
              收到：spawn / spawnAndWait / abort / resume
              产出：内存记录 + 排队 + 两个并发池

执行层     runAgent：拼提示词、削工具、createAgentSession、prompt 循环
              收到：调用描述
              产出：子会话事件回流到记录

工作流层   （可选）Worker + vm + 回宿主的 agent() RPC
              收到：JS 脚本
              产出：多次执行层调用，自己的并发上限

存储层     记录表（内存）/ session 文件 / 调度 JSON / MEMORY.md / 输出 JSONL
```

进程真相：

```text
┌──────────────────────────────────────────────────────┐
│ 宿主 Pi 进程                                           │
│                                                      │
│  根扩展激活 ──► 唯一的运行时管理器                       │
│       │              │                               │
│       │              ├─ 后台池（默认最多 10）            │
│       │              ├─ 前台池（默认 0 = 不限制）        │
│       │              └─ 嵌套子 Agent：不占上述名额        │
│       │                                              │
│       ├─ 子 AgentSession × N   （同进程，不是 child_process）
│       ├─ 工作流 Worker 线程     （只跑脚本；agent() 仍回宿主）
│       └─ croner / setTimeout    （本包自己的调度器）      │
│                                                      │
│  子会话再次加载本扩展时：检测到「我在子上下文」→ 直接 return  │
└──────────────────────────────────────────────────────┘
```

图纸和进程的差异点：**「子 Agent」在职责图上像一台工人，在进程上只是同进程对象。** 工作流线程容易被看成「Agent 沙箱」——它不是。vm 关掉了 `codeGeneration.strings`，目的是**确定性**（可 resume），文档自己写了这不是安全沙箱。

## 5. 它主要是一个 Pi 扩展；常驻的是宿主，不是它自己

证据：

- 工厂：`export default function (pi: ExtensionAPI)`。
- 子会话里工厂会早退：`inChildSessionContext()` 为真则 `return`。否则每个子会话再装一套管理器，通知和并发会计数会打结。
- 全局登记：`Symbol.for("pi-subagents:manager")`。只有**声明了这个槽**的那次激活，才有权在 shutdown 时删掉它。

装了什么：

| 产物 | 含义 |
|---|---|
| 三个宿主工具 + 可选工作流工具 | LLM 入口 |
| `/agents` | 人看正在跑的、改设置、看定时作业 |
| 编辑器上方 Widget、下方 Fleet | TUI，不是独立 App |
| 项目 `.pi/subagents.json` | Settings 写入处；全局 `~/.pi/agent/subagents.json` 只作只读默认 |

有没有常驻进程：**没有第二个 OS 进程。** 子会话、timer、RPC 全部活在宿主 Node 里。宿主退出：

1. abort 所有工作流 Worker
2. abort 所有子 Agent
3. 等子会话发完自己的 `session_shutdown`（有超时）
4. 清掉管理器

崩溃/重启语义：内存记录没了。不会在下次 `session_start` 把「当时正在跑的」从磁盘复活。能留下的是：持久化过的 session 文件（handle / `/resume`）、本 session id 下的调度 JSON、MEMORY.md。

和宿主的关系：寄生。被谁拉起的进程就归谁。

后台部分点名：

| 节点 | 载体 | 触发 | 备注 |
|---|---|---|---|
| 子 Agent 回合 | 同进程 AgentSession | spawn 成功后 `session.prompt` | 不是 child_process |
| 后台排队 | 管理器队列 | 后台池满 | 前台默认不排队 |
| 定时开火 | croner / setTimeout | `Agent({ schedule })` 或 `/agents` | `bypassQueue: true`，不占「满了就等」 |
| 工作流脚本 | `worker_threads` + vm | `SubagentWorkflow` | 独立并发上限，脚本里的 agent **不进**会话后台池 |
| git worktree | `pi.exec("git", …)` | `isolation: "worktree"` | 文件系统副本，不是权限牢房 |

## 6. 纵向链路：宿主说「去 Explore」，到父对话被叫醒

一条真实输入，八个节点。载体全程是宿主进程；模型调用发生在子会话对象上。

```text
工具调用 → 解析 → 登记/排队 → 建会话 → 子回合 → 结算记录 → （可选）持久化收尾 → 通知宿主
```

### 6.1 工具调用：收到 Agent tool call → 还不知道会不会真跑

宿主模型发出 `Agent`。工厂先 **reload** 自定义类型（每次执行都读盘，改 markdown 不必重启 Pi）。未知类型、被禁用的类型：在 spawn 之前就拒绝。

### 6.2 解析：收到参数 → 一份调用描述，或一份定时作业

合并顺序：工具参数 vs 类型 frontmatter vs 项目设置。几条判定：

- 顶层默认 `run_in_background: true`（立刻返回 id）。
- 嵌套子 Agent 默认**前台**（父亲多半在等）。
- 带 `schedule`：**只登记，不 spawn**。
- 带 `resume`：走恢复，不走新类型的空白会话。
- `isolation: "off"` 是拼写折叠，不是一种运行模式。

### 6.3 登记 / 排队：收到调用描述 → 内存里有一条记录

后台：`spawn` 立即把 id 还给工具。记录可能是 `queued`。  
前台：`spawnAndWait`，必要时先等入场券，再等跑完。

两个池互相独立。嵌套子 Agent、工作流内部的 `agent()` **不占**这两个池的名额——所以「我设了 maxConcurrent=10」推不出「全局最多 10 个 LLM 会话」。

worktree 的 git 拷贝在启动路径上 **await**。拷贝失败会让这次工具调用失败，而不是留下一个空转记录。

完成 ≠ 就绪：工具已经返回 id，只证明记录进表了。Agent 可能还在排队。

### 6.4 建会话：收到出队 → 同进程 AgentSession

拼系统提示、削工具、决定是否注入「嵌套版」Agent/result/steer（深度有上限，默认 2；0/1 等于禁止再套）。然后 `createAgentSession`。宿主那四个编排工具名在子会话里是排除名单——孩子不能继承父亲的 `Agent`，只能用专门注入的嵌套副本。

### 6.5 子回合：收到 prompt → 文本和工具事件回流

`session.subscribe` 听 `turn_end` 等。软上限 `maxTurns` 到了先 steer「收束」；再给几轮 grace，然后 abort。Widget 和 JSONL 输出吃的是这条事件流。

### 6.6 结算记录：收到 promise settle → status / result / 错

工作树有脏改动就提交到分支再删 worktree；干净则直接清。然后 `drainQueue` 放进下一个排队者。

### 6.7 持久化收尾：会话文件、tombstone、输出 JSONL

若开启 `rememberAgents`（非嵌套默认 true），session 文件留下来，GC 十分钟后记录变墓碑（handle + 文件路径），`@handle` 还能打开。会话切换会清墓碑。

### 6.8 通知宿主：后台且结果还没被取走 → followUp 叫醒

200ms 防抖。`get_subagent_result` 或 RPC `consume` 会打上「已消费」，**取消**这次 nudge——这是和 `pi-tasks` 对接时避免「任务工具已经等过结果，父对话又被 nudge 一次」的关键闸门。

前台路径没有这步：结果已经在工具返回值里。

```text
同步阶段：校验类型 → 登记记录 → 返回 id（后台）或挡住（前台）
异步阶段：排队 → 建会话 → 回合 → 结算 → 可能的 followUp
```

判定句：**后台 Agent 工具成功，只证明有了一条记录。长期结果在不在、父对话会不会被叫醒，要看排队、消费标记和宿主还在不在。**

## 7. 另外几条核心动词

链路数 = 核心动词数。这些可以独立成功失败，排错时逐条看。

**steer（改道）**  
会话还没建好：推进队。建好了：`session.steer`。人在输入框 `@handle 一句` 对**正在跑**的 Agent 也是 steer。

**取结果**  
`get_subagent_result`，可 `wait`。一取就标记已消费。嵌套版只能看见「我生的」孩子。

**恢复**  
进程还在、记录还在：`resume` / `@handle` 打开同一个 session 文件再跑。  
进程死了：内存表空。持久化过的文件仍可能出现在 Pi `/resume` 里，但不会自动变成 running。

**本包的 schedule**  
和 Heartbeat 扩展不是一家。作业文件按 **session id** 分，PID 锁，原子写。`/resume` 同一 session 会把 timer 再挂上；`/new` 换 id 等于换一份空表。开火走 `spawn(..., { bypassQueue: true, isBackground: true })`，所以定时任务可以在后台池已满时插队。

**worktree**  
git 副本。父仓库未提交的改动**看不见**。不是 seccomp、不是另一个用户。项目级开关可以关掉。frontmatter 写了 `isolation: off` 会否决调用方的 worktree。

**@类型名 且现场没有活着的这个类型**  
走 mention-clone：克隆对话，让克隆去调**正式注册的** `Agent` 工具（这样 Widget / transcript / 分组都在），再丢掉克隆。看起来像斜杠命令，落地仍是同一条 spawn 链路。

## 8. 工作流是另一条运行时，不是 Agent 的别名

`SubagentWorkflow` 默认开启，可用设置关掉。工具描述本身大约 +5k tokens（对齐 Claude Code 合同），这是上下文成本，不是实现细节。

```text
宿主工具立刻返回
  → 本进程启动 Worker
  → Worker 里 vm 跑用户 JS
  → JS 调 agent() / parallel() / pipeline()
  → postMessage 回宿主 → 管理器 spawnAndWait
  → 结果再进脚本
```

上限（易变，但语义稳定）：会话级后台池管不到这里；工作流自己有一套并发（大约 `min(16, cpus-2)`）、单次 run 最多 1000 个 agent、一层 `parallel`/`pipeline` 最多 4096 项。`gate: 'npm test'` 是跑命令验对错，不是再问一个模型「看起来对不对」。

脚本可 resume：journal 记下已经完成的 `agent()` 前缀。所以 vm 禁掉动态代码生成——为了前缀可复放，不是为了防恶意脚本。

## 9. 和另外两个扩展怎么接

```text
pi-schedule-prompt    给「当前对话 / 一次性内存会话」做心跳
pi-subagents          给「具名类型的子会话」做运行时
pi-tasks              给「任务清单」做权威表，执行时来问本包
```

本包源码里搜不到 `pi-schedule-prompt`。两套调度器可以同时挂在同一个 Pi 进程里，互不读写对方的 JSON。

`pi-tasks` 的 `TaskExecute` 发 `subagents:rpc:spawn`；`TaskOutput` 等完发 `subagents:rpc:consume`，避免完成 followUp 和任务工具双通道各喊一次。总线是 `pi.events.emit`，协议版本 2，**过不了进程边界**。本包没装、版本不对、当前会话把本扩展滤掉：RPC 就是「没有活跃会话」。

## 10. 边界、误区

| 词 A | 词 B | 钉死 |
|---|---|---|
| 子 Agent | 子进程 | 同进程 AgentSession |
| 工作流 Worker | Agent 沙箱 | Worker 只跑 JS；模型仍在宿主 |
| Agent 类型 | 一次运行 | 类型是策略文件；运行是内存记录 |
| 本包 schedule | pi-schedule-prompt | 不同文件、不同工具、不同执行器 |
| 后台池 maxConcurrent | 全局 LLM 上限 | 嵌套、定时、工作流内部都不按这个上限理解 |
| 前台池 0 | 「前台也限 10」 | 0 = 不限制。一条消息里一堆 `run_in_background: false` 会一起跑 |
| rememberAgents | 重启后自动接着跑 | 只留下 session 文件，不复活 running |
| worktree | 安全隔离 | 看不见未提交改动；Node 权限还是同一份 |
| 仓库 AGENTS.md | `.pi/agents/*.md` | 前者给贡献者，后者才是类型 |

常见误区，两句式：

- **「Fleet 是个独立界面程序。」错。** 正：宿主 TUI 的一块 widget。
- **「package.json 有 main，能当库 require。」错。** 正：Pi 直接加载 `src/index.ts`。
- **「子会话会再装一遍本扩展，所以能递归无限 spawn。」错。** 正：子上下文工厂早退；嵌套靠专门注入的工具，还有深度帽。
- **「RPC 能从另一个终端把 Agent 拉起来。」错。** 正：同一 Pi 进程内的事件。

可靠性边界：没有包住「所有子会话 + 工作流 + 调度」的总事务。宿主没了，未消费的结果不会投递。这是当前可靠性边界。

## 11. 失败形态与排错

**调了 Agent，立刻失败，没有 id**  
先看类型名是否存在、是否被项目禁用、模型是否落在 `scopeModels` 之外（调用方乱填是硬错误；frontmatter 继承是警告后继续）。worktree 在非 git 仓库上的严格隔离也会让工具调用失败。不要先怀疑管理器队列。

**返回了 id，Widget 一直 queued**  
后台池满。看 `/agents` 设置的 `maxConcurrent`。定时开火不走这条队列；别用定时作业来测排队。

**跑完了父对话没动静**  
1. 是不是前台？前台结果在工具返回值里，没有 followUp。  
2. 有没有人已经 `get_subagent_result` 或 tasks 侧 `consume`？消费了就不 nudge。  
3. 宿主是不是已经 `session_shutdown`？

**子 Agent 里还能看到 Agent 工具，以为是宿主那份**  
那是嵌套副本，有深度和 allowlist。不是「扩展被加载了两次」。

**TaskExecute 说 subagents 不可用**  
本包没加载、peer 版本不够、协议不是 v2、ping 5 秒没回。查 `pi-tasks` 那条链路，见[看懂 pi-tasks](./看懂%20pi-tasks.md)。

**`/resume` 以后看不到当时正在跑的 Agent**  
设计如此。内存表不写盘。去 Pi 自己的 session 列表里找持久化过的子会话，或看调度 JSON 还在不在。

**工作流里 agent() 很慢，会话后台池却是空的**  
工作流不进那个池。看工作流自己的并发和脚本是 `parallel` 还是意外写成了串行 `await`。

## 12. 总结

1. **运行形态是 Pi 扩展。** 子 Agent 是同进程会话；唯一额外的 OS 线程是工作流脚本 Worker。
2. **内存记录是本次会话的运行真相，不是持久真相。** 跨回合靠 session 文件、调度 JSON、MEMORY.md。
3. **一个根会话一个管理器；子会话不得再激活一套。**
4. **后台默认、嵌套默认前台、两个池、嵌套不占名额、定时插队。** 不要用一个数字理解所有并发。
5. **`resultConsumed` 是父对话 nudge 的唯一闸门。** 工具和 RPC 共用。

如果只记一条完整主线：

```text
宿主 Agent 工具
  → 读类型 markdown、合并调用配置
  → 管理器登记记录（后台立刻还 id / 前台挡住）
  → 同进程 createAgentSession（孩子看不到宿主编排工具）
  → 回合事件写回记录
  → 结算、清 worktree、放队列
  → 未消费则 followUp 叫醒宿主
  → 宿主退出：abort 一切；磁盘只留持久化过的会话和本 session 的 schedules
```

## 13. 深入通道：按调用链读

1. `package.json` + `src/index.ts` 工厂开头 + `src/child-context.ts`  
   怎么接到 Pi、子会话为什么必须早退、Symbol 槽属于谁。

2. `src/index.ts` 里 `Agent` / `get_subagent_result` / `steer_subagent` 的 execute  
   人话入口。看 reload 类型、schedule 短接、后台 vs 前台、消费标记。文件很长，不要从头扫 UI。

3. `src/invocation-config.ts` + `src/agent-types.ts` + `src/default-agents.ts` + `src/custom-agents.ts`  
   类型从哪来、参数和 frontmatter 谁赢、`isolation: "off"` 怎样消失。

4. `src/agent-manager.ts`  
   记录表、两个池、排队、abort、resume、GC、dispose。看完应能回答「queued 是谁的状态、嵌套占不占名额」。

5. `src/agent-runner.ts` + `src/prompts.ts` + `src/nested-tools.ts`  
   一次运行怎样变成 AgentSession。重点：`EXCLUDED_TOOL_NAMES`、嵌套深度、持久化 vs 内存 SessionManager。

6. `src/schedule.ts` + `src/schedule-store.ts`  
   确认这不是 Heartbeat 扩展。session 文件路径、PID 锁、`bypassQueue`。

7. `src/cross-extension-rpc.ts` + 上游 `docs/rpc.md`  
   ping/spawn/stop/consume。再去 `pi-tasks` 对 `TaskExecute`。

8. `src/workflow/runtime.ts` + `host.ts` + `worker-source.ts` + `journal.ts`  
   脚本线程、回宿主的 agent()、resume 前缀。组末：工作流终点连回「一次运行」——`agent()` 并不另搞一套 Agent。

9. `src/worktree.ts` + `src/memory.ts` + `src/output-file.ts` + `src/ui/agent-widget.ts` + `src/ui/fleet-list.ts`  
   隔离、留下的文件、人看见什么。UI 只读管理器的记录。

本仓库另有源码课：[pi-subagents.md](./pi-subagents.md)、[pi-subagents-source-course](./pi-subagents-source-course/)。冲突以源码为准。

### 参考资料

- https://github.com/tintinweb/pi-subagents
- https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md
- https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md
- https://pi.dev
