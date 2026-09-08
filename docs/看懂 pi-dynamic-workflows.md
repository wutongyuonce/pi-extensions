# 看懂 pi-dynamic-workflows：宿主写脚本，沙箱里扇出子代理

> 本文面向第一次接触 `pi-dynamic-workflows`、但已经知道「Pi 是编码 Agent、扩展会往宿主里注册工具」的读者。重点不是罗列函数名，而是讲清：它解决什么问题、脚本实际在哪个进程里跑、`agent()` 是不是真隔离、失败时仓库会不会被改掉。
>
> **本文定位：小项目、二次开发深度。** 稳定认知放在职责边界与数据流上；工具参数、并发默认值、提示词文案属于易变细节。这是一个 **prototype**：核心原语已实现，**没有**持久化 run、**没有**断点续跑、**没有** `/workflows` 管理器。
>
> 源码基线：本仓库 `pi-dynamic-workflows`，包版本 `1.0.1`；工作区 HEAD `6f1c21c`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游独立仓库：[Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)。灵感来源：[Claude Code dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)。

## 1. TLDR：它做的事情可以压缩成两条链路

宿主模型并不自己「并行干活」。它写一段很小的 JavaScript，交给一个叫 `workflow` 的工具；工具在沙箱里跑这段脚本，脚本再多次调用 `agent()`，每次 `agent()` 在内存里新开一个 Pi 子会话。

```text
用户一句话
  → 宿主模型写 workflow 脚本
  → workflow 工具：AST 校验 → vm 沙箱执行
  → 脚本里的 agent() / parallel() / pipeline()
  → 每个 agent()：内存 Session + coding tools + 可选 structured_output
  → 沙箱把可 structured-clone 的结果交回宿主
```

第二条是单次子代理：

```text
agent(prompt, { schema? })
  → createAgentSession（内存会话，cwd 与宿主相同）
  → 子模型用工具干活
  → 有 schema：必须调用 structured_output（terminate: true）
  → 没 schema：取最后一段助手文本
  → session.dispose()，会话不落盘
```

所以它不是：

- **不是** Pi 内置的 `/agents` 工作流运行器。它只是一个扩展工具，宿主模型决定何时调用。
- **不是** 独立 daemon / 队列服务。脚本跑在当前 Pi 进程里，工具返回后一切结束。
- **不是** 文件系统隔离。`isolation: "worktree"` 目前只写进子代理的系统提示，**不会**真的建 git worktree。
- **不是** 可恢复的 run。关掉会话或 abort，现场就没了。

正面定义：它是挂在 Pi 上的 **动态编排原语**——宿主负责「拆成什么图」，运行时负责「按图扇出、收集、渲染」。

权威数据源尽早说清：

- **脚本源码**是这次 run 的权威输入，只活在这一次工具调用里。
- **子代理的返回值**（`structured_output` 或最后一段文本）是权威产出。
- TUI 进度条是派生视图，改文案不必改运行时。

## 2. 为什么不能让一个助手从头干到尾

普通 Pi 回合是单线程的：一个模型、一条工具链、顺序执行。审计整仓、多视角审查、扇出检索时，这个模型会自己串行读文件，上下文被撑爆，视角也混在一起。

这个扩展把「怎么拆」从框架代码里拿出来，交给**这一次**的宿主模型：它现场写脚本，而不是调用预先注册好的固定 DAG。

正反例：

| 该用 workflow | 不该用 workflow |
|---|---|
| 要对 20 个文件各跑一次独立审查，再汇总 | 改一个函数、跑一遍测试 |
| 需要「正确性 / 安全 / 能否复现」三个独立视角 | 只要当前会话里的连续推理 |
| 想用 `pipeline` 让条目 A 先走完、不必等条目 B | 步骤之间必须共享同一段对话记忆 |

职责分工可以压成四行：

- **宿主模型**判断「要不要开 workflow、脚本写成什么样」。
- **解析器**决定这段 JS 能不能进沙箱（`export const meta`、禁止 `Date.now()` / `Math.random()` / `new Date()`）。
- **沙箱运行时**只提供 `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `budget`，没有 `fs`、没有 `fetch`、没有 `require`。
- **子代理**才是真正读仓库、跑命令的人；它和宿主共用 `cwd`。

不要把「脚本在 vm 里」理解成「子代理也在沙箱里」。vm 管的是编排代码；子代理是完整的 Pi session。

## 3. 先看整体架构，不急着看类名

文档视角（职责）：

```text
宿主对话层     收到用户请求 → 决定调用 workflow → 把 script 字符串交出去
     ↓
工具适配层     去 markdown 围栏、接 abort、把进度画成 TUI
     ↓
解析层         acorn 走 AST → 抽出字面量 meta → 剥掉第一句 export
     ↓
沙箱编排层     vm 里跑 body：phase / agent / parallel / pipeline
     ↓
子代理执行层   内存 Pi session + coding tools（外加可选 structured_output）
     ↓
结果收集层     要求返回值可 structuredClone → JSON 文本交回宿主
```

每层收到什么 → 做什么 → 产出什么：

| 层 | 收到 | 做 | 产出 |
|---|---|---|---|
| 宿主对话 | 用户自然语言 | 写 JS 脚本并调用工具 | `script` 字符串 |
| 工具适配 | 工具参数 | 规范化、直播进度、处理 abort | 给模型看的文本 + `details` 快照 |
| 解析 | 原始脚本 | 拒绝非确定性 AST、校验 meta | `{ meta, body }` |
| 沙箱编排 | body | 限流并发、记 log/phase | 脚本的 return 值 |
| 子代理 | prompt + 可选 schema | 一次完整的模型回合 | 结构化对象或一段文本 |
| 结果收集 | return 值 | clone 检查、拒绝「忘了 await」 | 工具结果 |

进程真相（下一章揭）：上面六层**全部住在当前 Pi 进程里**。没有单独的 workflow 服务器。「编排层」是代码职责，不等于一台持续监听端口的服务。

和图纸不一致的那一点才是精华：README 写 *isolated subagents*，读者容易以为每个子代理有自己的磁盘副本。源码里 `WorkflowAgent` 用 `createCodingTools(this.cwd)`，默认就是宿主工作区。隔离的是**会话内存**（`SessionManager.inMemory`），不是工作区。

## 4. 实际怎样运行：它是一个会自激活的工具，不是常驻服务

证据不在 README 的形容词里，在安装产物里：

- `package.json` 的 `pi.extensions` 指向 `extensions/workflow.ts`。
- 入口只做两件事：`pi.registerTool(workflowTool)`，以及 `session_start` 时若工具不在 active 列表里就加进去。
- 没有 `bin/`、没有 Dockerfile、没有 listen 端口。

装了什么、跑起来是什么：

```text
pi install npm:pi-dynamic-workflows
  → Pi 加载扩展
  → 注册名为 workflow 的工具
  → 新会话自动激活该工具
  → 用户不必再开一个进程
```

有没有常驻进程：**没有。** 每次工具调用在当前进程里 `vm.Script.runInContext`，子代理 `createAgentSession` 也在当前进程；工具返回（或 abort）后 `session.dispose()`，对象随这次调用一起消失。用户不需要另外启动 workflow 服务。

后台部分点名：`parallel()` / `pipeline()` 会并发跑多个 `agent()`，但它们是进程内的 Promise，不是 worker 线程，也不是子进程池。并发上限是 `min(16, hardwareConcurrency-2)`，写死在运行时里。

和宿主的关系：

```text
Pi 宿主进程
  ├─ 主会话（写脚本的那个模型）
  ├─ workflow 工具（扩展代码）
  └─ N 个内存子会话（agent() 期间短暂存在，dispose 即没）
```

被谁拉起的进程就归谁：这里没有第二进程。子代理能改磁盘，是因为它们拿到了和宿主一样的 coding tools。

prototype 边界（官方 Status 节，不要假装已经有）：

- 不持久化 run，不能 resume。
- 没有 `/workflows` 面板。
- `opts.isolation` / `opts.model` / `opts.agentType` 目前主要变成子代理提示词里的一行字，不是运行时真去切 worktree / 换模型注册表（模型可经 `session` 选项覆盖，扩展工具调用时会把宿主的 `modelRegistry` 和当前 `model` 传进去）。

## 5. 纵向链路一：用户说「跑个 workflow」之后发生了什么

切层连读就是整条链路：宿主层 → 规范化层 → 解析层 → 沙箱层 → 收集层。

```text
用户自然语言 → 宿主写 script → 去围栏 → AST 解析 → vm 执行 → JSON 结果
```

### 5.1 宿主层：收到用户请求 → 决定写脚本 → 产出 script 字符串

载体：Pi 主会话，同步的模型回合。扩展在 `session_start` 把 `workflow` 放进 active tools，模型才看得到它。脚本必须第一句是字面量：

```js
export const meta = { name: "short_snake_case", description: "non-empty description" };
```

`meta.phases` 只是文档；真正驱动进度条的是运行时 `phase(title)`。

### 5.2 规范化层：收到工具参数 → 去掉 markdown 围栏 → 产出干净 JS

载体：当前进程，同步。模型经常把脚本包在 ` ```js ` 里，工具会剥掉。这一步失败会直接抛「workflow requires `script` to be a string」，仓库无变化。

### 5.3 解析层：收到脚本 → acorn + 字面量求值 → 产出 meta 和 body

载体：当前进程，同步。`meta` 必须是纯字面量对象，禁止 spread、计算属性、函数。顺手扫整棵 AST：出现 `Date.now()` / `Math.random()` / `new Date()` 就拒绝。理由：脚本应当可复放；时间与随机数会让同一段脚本两次跑出不同图。

完成 ≠ 开始跑：解析成功只证明「形状合法」。一个只写了 `phase()` 从没调用 `agent()` 的脚本，会在全部跑完后被工具拒绝。

### 5.4 沙箱层：收到 body → 在 vm 里跑编排 → 产出 return 值

载体：当前进程的 `node:vm`，异步。注入的全局几乎就是一张白名单：`agent`、`parallel`、`pipeline`、`log`、`phase`、`args`、`budget`、`console`、`JSON`、`Math`、常用构造器。没有 `fs`，`process` 被冻成只含 `cwd()`。

同步 / 异步设计：

- `phase()` / `log()` 同步记账，立刻推 TUI。
- `agent()` 走限流器，超并发就排队。
- `parallel(thunks)` 是屏障：必须传入**函数**而不是 Promise（`await parallel([agent(...)])` 会在进入 parallel 之前就开跑，所以直接 TypeError）。
- `pipeline(items, ...stages)` **没有**阶段屏障：条目 A 可以已经到 stage 3，条目 B 还在 stage 1。

失败策略：单个 `agent()` / 某个 parallel 槽 / 某条 pipeline 失败时，默认 **log + 返回 `null`**，不让整张图炸掉。宿主 abort 除外——abort 会往上抛。

### 5.5 收集层：收到 return 值 → structuredClone 检查 → 产出工具结果

载体：当前进程，同步。返回值必须能 `structuredClone`。这是在抓「忘了 await」：如果你 `return { reviews: pipeline(...) }` 而没 await，手里拿的是 Promise，clone 会失败。

工具还要求 `agentCount >= 1`。只声明 phase、一次 `agent()` 都没调用，算编排失败，不算成功的空跑。

**完成 ≠ 子代理都成功。** 工具返回 200 字的 JSON，里面可以塞着若干 `null`。要看 `details` 里每个 agent 的 `status`（`running` / `done` / `error` / `skipped`）。

可靠性收束：

| 失败位置 | 仓库是否被改 | 进度是否可恢复 | 下次怎么办 |
|---|---|---|---|
| 解析失败 | 否 | 无 run 可恢复 | 改脚本再调一次 |
| vm 抛错 / abort | 可能（已启动的子代理可能已写盘） | 否 | 当普通失败回合处理 |
| 单个 agent() 失败 | 该子代理已做的写入还在 | 该槽位变成 `null` | 脚本自己 `.filter(Boolean)` |
| 子代理改了文件但没 structured_output | 文件已变 | 该 agent() 抛错→`null` | 不要假设磁盘回滚 |

当前**没有**包住所有子代理写入的总事务。这是可靠性边界。

## 6. 纵向链路二：一次 `agent()` 从进到出

```text
限流拿到名额 → 建内存 session → prompt → （可选）structured_output → dispose
```

### 6.1 准备层：拿到 prompt → 拼工具列表 → 产出即将启动的 session 配置

`createCodingTools(cwd)` 是默认工具集，外加调用方传入的 extra tools。若带了 `schema`，再塞一个终止工具 `structured_output`：Pi 先按 JSON Schema 校验参数，`execute` 里 `terminate: true`，子代理不必再花一轮「我已经说完了」。

### 6.2 会话层：收到配置 → `SessionManager.inMemory` → 产出活着的子会话

载体：仍是宿主进程，不是 fork 出来的 `pi` 子进程。会话不写 `~/.pi/agent/sessions`。`cwd` 默认 `process.cwd()`，扩展调用时是 `ctx.cwd`。认证、模型注册表沿用宿主（工具把 `ctx.modelRegistry` / `ctx.model` 传进去）。

### 6.3 模型工作层：收到 prompt → 普通 Pi 回合 → 产出工具副作用 + 最终答案

这一层是**模型工作**，不是纯代码。子代理可以 `read` / `edit` / `bash`，所以它和宿主抢同一份磁盘。`opts.isolation: "worktree"` 此时只是提示词里的 `Requested isolation: worktree`，不会真的切工作副本。

有 schema 时：结束动作必须是一次 `structured_output`。没调用就抛 `Subagent finished without calling structured_output`，外层把它变成 `null`。

没有 schema 时：从后往前找最后一段助手文本。子代理「只调了工具没说话」会得到空字符串。

### 6.4 拆除层：回合结束 → `session.dispose()` → 会话消失

内存会话不留历史。你无法事后 `/tree` 进某个子代理的对话。要留证据，只能靠脚本 `return` 的那份 JSON，或子代理自己写进仓库的文件。

token 预算是粗估：`JSON.stringify(result).length / 4`。`budget.total` 在这个扩展的默认工具路径上是 `null`，`remaining()` 为 `Infinity`——脚本里写 `while (budget.remaining() > 50_000)` 不会按你想象的方式刹车。

## 7. 把最容易混的词钉死

| 词 | 是 | 不是 |
|---|---|---|
| workflow 脚本 | 一次工具调用的编排源码 | 可复用、可 resume 的工作流定义 |
| `meta.phases` | 给人看的声明 | 运行时进度（进度看 `phase()`） |
| `agent()` | 内存 Pi 子会话 | OS 进程 / git worktree |
| `isolation` | 写进提示词的请求 | 已实现的磁盘隔离 |
| `parallel()` | 屏障，收集全部 thunk | 自动限流以外的线程池 |
| `pipeline()` | 每条 item 独立穿过 stages | 阶段之间的全局屏障 |
| 工具成功返回 | 脚本跑完且至少调用过一次 agent | 每个子代理都成功、磁盘可整体回滚 |

常见误区：

- **错。** 以为 `vm` 能阻止子代理改文件。**正。** vm 只限制编排脚本；子代理拿的是完整 coding tools。
- **错。** 以为 `return pipeline(...)` 不用 await。**正。** 运行时会用 `structuredClone` 抓你，报错信息会问你是不是忘了 await。
- **错。** 以为失败的 agent 会让整个 workflow 失败。**正。** 默认吞成 `null`，要自己 filter。
- **错。** 以为这就是 Claude Code 的 `/workflows` 管理器。**正。** 官方自己写了：还没有 persisted runs，也没有管理命令。

## 8. 失败时你能看见什么

症状式，按用户能观察到的现象排：

**工具立刻报 script/meta 错误。** 先看第一句是不是字面量 `export const meta`，再看有没有 `Date.now()`。不要先怀疑 Pi 没装上扩展——没装的话模型根本调不到这个工具。

**TUI 有进度，最后却说 must call agent() at least once。** 脚本只 `phase()` / `log()` 了。进度条不是成功证明。

**结果 JSON 里大片 `null`。** 对应子代理失败或某条 pipeline 中途抛错。去 `details.agents[].status`。磁盘可能已经被其中几个成功的子代理改过。

**用户按 Esc，进度条上的 running 变成 skipped。** abort 走工具的 `signal`；正在跑的 session 会 `session.abort()`。已写入的文件不会自动 undo（那是 `pi-workspace-history` 的职责，不是本包的）。

**子代理明明在跑，却像没用宿主的模型。** 查 `createWorkflowTool` 有没有把 `ctx.modelRegistry` 传进 `runWorkflow`。默认路径会传；自己当库调用 `runWorkflow()` 时要自己传 `session`。

## 9. 如果只记一条主线

可独立验证的稳定事实：

1. 形态是 **Pi 扩展工具**，不是服务；随工具调用生灭。
2. 编排脚本在 **vm 白名单**里跑；真正碰仓库的是 **内存子会话**。
3. 子代理默认 **共享宿主 cwd**；会话隔离 ≠ 磁盘隔离。
4. 单槽失败变 `null`，没有覆盖全部写入的总事务。
5. 当前不能 resume、不能在重启后找到某次 run。

如果只记一条完整主线，可以记成：

```text
宿主写 JS
  → 解析器拒绝非确定性
  → vm 里 agent()/parallel()/pipeline()
  → 每个 agent() 开内存 Pi 会话（共用 cwd）
  → 结构化结果（或 null）交回宿主
  → 进程里不留下 run
```

## 10. 想改代码时按这个顺序读

1. `extensions/workflow.ts`：扩展怎么挂上、为什么 `session_start` 要强行激活工具。
2. `src/workflow-tool.ts`：工具合同、去围栏、abort、TUI 快照。看了能懂「用户看见的进度从哪来」。
3. `src/workflow.ts` 的 `parseWorkflowScript`：meta 字面量规则 + 非确定性禁令。
4. `src/workflow.ts` 的 `runWorkflow`：vm 白名单、限流、`null` 失败语义、`parallel` vs `pipeline`。
5. `src/agent.ts`：内存 session、coding tools、dispose。看了能懂「隔离到底隔离了什么」。
6. `src/structured-output.ts`：为什么 `terminate: true` 能少一轮收尾。
7. `src/display.ts`：快照是派生视图。改文案不必改运行时。
8. `tests/workflow-parser.test.ts`：接受 / 拒绝的脚本形状，这是解析器的行为合同。

本地冒烟：`pi install /path/to/pi-dynamic-workflows`，`/reload`，然后说「跑一个 workflow 列出本仓库主模块」。看到 `workflow` 工具调用、子代理进度、最终 JSON，即整条链路通了。

## 参考资料

- [pi-dynamic-workflows README](https://github.com/Michaelliv/pi-dynamic-workflows)
- [Claude Code: introducing dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
