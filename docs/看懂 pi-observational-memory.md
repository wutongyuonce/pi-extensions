# 看懂 pi-observational-memory：会话内账本怎样撑过 compaction

> 本文面向已经会用 Pi、想搞清「这个扩展到底把记忆写在哪、压缩时发生了什么」的读者。不需要先读过 Mastra 论文。本文定位：二次开发深度（给到文件级阅读顺序，不逐类铺开）。
>
> 源码基线：本仓库 HEAD `6f1c21cebfdc0bf6b25657ff4f80005a6d40e517`（2026-09-08），包版本 `3.0.4`。上游：[elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)。V3 仍在主分支演进，稳定认知放在职责边界与数据流上；阈值、默认模型和 UI 文案都可能变。
>
> 官方技术参照：包内 [`docs/concepts.md`](../memory/pi-observational-memory/docs/concepts.md)、[`docs/how-it-works.md`](../memory/pi-observational-memory/docs/how-it-works.md)。灵感来源：[Mastra Observational Memory](https://mastra.ai/blog/observational-memory)。

## 1. TLDR：它做的事情可以压成三条链路

`pi-observational-memory` 给**当前这一次 Pi 会话**加一套可折叠的记忆账本，让长对话在 compaction（上下文压缩）之后还能接上。

```text
记账：
用户回合结束
→ 后台 Observer 从原始消息抽出 observations
→ 到阈值后 Reflector 写成 reflections
→ 同轮反射成功后，才允许 Dropper 给过时 observation 打墓碑
→ 全部以 custom entry 追加进当前 session 分支

撑过压缩：
上下文涨过阈值
→ agent_settled 调用 ctx.compact()
→ session_before_compact 折叠账本、无模型渲染摘要
→ 投影为空则放弃接管，交给 Pi 原生 summarizer

找回证据：
Agent 看到摘要里的 [id]
→ 调用 recall 工具
→ 从当前分支账本（含已 drop）找回原文和 source entries
```

所以它不是：

- 跨会话记忆库（关掉这次 session，账本就跟着这次 session 的 JSONL 走，不会写到 `~/.pi/agent/` 下一份独立 MEMORY.md）
- 向量数据库或 embedding 检索
- 常驻 daemon / 独立记忆服务
- 给宿主 Agent 再包一层聊天
- 把 compaction 再交给另一个模型写摘要（投影非空时，摘要是模板渲染，不调模型）

正面定义：它是挂在 Pi 扩展钩子上的**会话内记忆账本**。后台小模型负责记账；compaction 时用确定性折叠，把账本投影成宿主还能看见的摘要。

这里最重要的职责边界：

| 谁 | 负责什么 | 不负责什么 |
|---|---|---|
| Observer / Reflector / Dropper | 判断「这段对话里什么值得记、什么可以从活跃池拿掉」 | 不写 compaction 摘要，不改宿主正在说的话 |
| 账本折叠（`foldLedger`） | 从当前分支 custom entry 重建「现在记得什么」 | 不调模型；无效/旧 V2 条目直接跳过 |
| Compaction 钩子 | 把折叠结果渲染成宿主看到的 summary | 投影为空时不抢权 |
| 宿主 Agent | 继续干活；需要原文时调用 `recall` | 不维护账本 |

权威数据源尽早说清：**当前分支上的 V3 ledger custom entries 是记忆真相**。Pi compaction 摘要只是「Agent 看见什么」。看见摘要 ≠ 账本已经是那个样子。

## 2. 为什么不能只靠 Pi 原生 summarizer

Pi 自己会在上下文变长时把旧消息压成一段摘要。这段摘要一旦偏了，后面几天的重构、排错、迁移就会丢线：做过的被重做，约束被忘掉，决策对不上。

这个扩展把两件不该混在一起的事拆开：

- **发生过什么 / 结论是什么** → 写成可折叠的 observation 和 reflection，活在 session 分支里
- **Agent 这一轮还能看见哪一段** → compaction 时从账本投影出来

正例：一次多日重构里，「已经改完 auth middleware、下一步是 session cookie」应当变成 reflection；具体哪次工具调用改了哪个文件，变成带 `sourceEntryIds` 的 observation。压缩之后宿主仍能看见这些句子，需要原话时用 `recall` 把 source entries 捞回来。

反例：不要指望它记住**另一次** session 里用户的偏好。那是 `pi-hermes-memory` 这类跨会话存储的工作。也不要把 compaction 摘要当成可以 grep 的档案——摘要会被下一轮压缩替换；账本条目会留下。

所以架构判断是：

```text
后台模型管「记什么」（质量）
扩展管「何时记、记在哪、压缩时怎么投影」（流程）
ledger custom entries 是交接结果（权威）
compaction summary 只是给宿主看的投影（派生）
```

## 3. 先看整体架构，不急着看类名

文档视角的职责分层：

```text
宿主对话层        用户和 Pi 正常聊天，消息进 session JSONL
        ↓
触发层            turn_end / agent_start / agent_settled / session_before_compact
        ↓
后台记账层        Observer → Reflector →（同轮成功才）Dropper
        ↓
账本层            om.observations.recorded / om.reflections.recorded / om.observations.dropped
        ↓
折叠与投影层      foldLedger → 活跃池 / 可见投影 / 全量投影
        ↓
宿主看见的摘要    renderSummary 拼出来的 Markdown；空则退回 Pi 原生摘要
```

每一层「收到什么 → 做什么 → 产出什么」：

| 层 | 收到 | 做 | 产出 |
|---|---|---|---|
| 触发层 | Pi 生命周期事件 | 看阈值、看 `passive`、看是否已有任务在飞 | 决定是否启动 worker 或 `ctx.compact()` |
| Observer | 尚未覆盖的原始/source entries | 调模型，用 `record_observations` 工具记账 | `om.observations.recorded` |
| Reflector | 当前活跃 observations + 已有 reflections | 调模型，用 `record_reflections` 工具写结论 | `om.reflections.recorded` |
| Dropper | 同轮新 reflections + 超标的活跃 observation 池 | 调模型，按 id 打墓碑 | `om.observations.dropped` |
| 折叠层 | 当前分支 entries | 从根扫到边界，first-valid-wins，drop 是墓碑 | 活跃 observations、全部 reflections、dropped id 集合 |
| 投影层 | 折叠结果 + compaction 边界 `firstKeptEntryId` | 无模型裁剪到 pool 上限，渲染 summary | 宿主看到的压缩文本；或放弃接管 |

类名只在它刚好是分层边界时出现：`Runtime` 是进程内的飞行状态（谁在跑、上次失败原因），不是服务器。

## 4. 它主要是一个寄生在 Pi 进程里的扩展

证据不是 README 自述，是安装产物和入口。

`package.json` 的 `pi.extensions` 指向 `./src/index.ts`。`pi install` 之后，Pi 启动会话时在**当前 Pi 进程**里加载这个函数，注册钩子、命令和工具。没有 `bin/`，没有监听端口，没有 cron，没有 `sessions.db`。

```text
用户的 Pi 进程
├── 宿主 Agent 主循环
├── 本扩展（同一进程）
│   ├── Runtime：飞行锁、配置、上次 worker 错误
│   ├── 钩子：turn_end / agent_start / agent_settled / session_before_compact
│   ├── 命令：/om:status、/om:view
│   └── 工具：recall
└── 后台 worker（仍是同一进程里的 Promise + agentLoop）
    ├── Observer
    ├── Reflector
    └── Dropper
```

「后台」是代码职责，不等于一台持续跑着的记忆服务。Observer 用的是 `@earendil-works/pi-agent-core` 的 `agentLoop` + `streamSimple`，在宿主进程里另开一轮短对话；跑完就结束。用户不需要另外启动任何东西。

和宿主的边界：

| 节点 | 载体 | 触发时机 |
|---|---|---|
| 记账流水线 | 宿主进程内的 tracked Promise | `agent_start` 或 `turn_end`，且 Observer 或 Reflector 到期、且没有 consolidation 在飞。Dropper **没有**自己的到期时钟 |
| 主动压缩 | `setTimeout(0)` 之后调用 `ctx.compact()` | `agent_settled`（Pi 已结束重试和排队续跑）且 raw token 过阈值 |
| 压缩载荷 | 同步折叠 + 字符串拼接 | `session_before_compact` |
| recall | 宿主 Agent 的工具调用，同步读当前分支 | Agent 决定要看原文时 |
| 配置 | 读文件，不常驻 | 每次触发 `Runtime.ensureConfig(cwd)` |

配置来源（后者覆盖前者）：

```text
内置 DEFAULTS
→ ~/.pi/agent/settings.json 的 "observational-memory"
→ <cwd>/.pi/settings.json 的 "observational-memory"
→ 环境变量 PI_OBSERVATIONAL_MEMORY_PASSIVE
```

当前默认阈值（易变，只作量级）：`observeAfterTokens = 10000`，`reflectAfterTokens = 20000`，`compactAfterTokens = 81000`，活跃 observation 池上限 20000、目标 10000。未配置 `model`、或配置的模型在 registry 里找不到时，都回退到当前会话模型。`passive: true` 关掉记账和自动 compact，不拆掉钩子本身。

没有独立记忆文件。账本就是 Pi session JSONL 里的 custom entries，经 `pi.appendEntry(customType, data)` 写进去。换分支、压缩、会话文件怎么存，都跟 Pi 自己的 session 机制走。

## 5. 纵向链路一：一次回合怎样变成账本条目

这条链路回答「记忆是怎么写进去的」。同步阶段很短，真正费时的是后台模型。

```text
Pi 发出 turn_end 或 agent_start
→ 触发层判断是否到期
→ Observer 吃原始消息
→ 追加 om.observations.recorded
→ Reflector 吃活跃 observations
→ 追加 om.reflections.recorded
→ 仅当本轮反射非空成功，Dropper 才可能打墓碑
→ 追加 om.observations.dropped
```

### 5.1 触发层收到生命周期事件 → 决定是否开工 → 产出一次 consolidation 任务

`registerConsolidationTrigger` 挂在 `agent_start` 和 `turn_end` 上。同一时刻只允许一条流水线（`runtime.consolidationInFlight`）。`passive` 为真直接返回。

「到期」看的是 token 进度，锚点是上一次成功记账留下的 `coversUpToId`。这个字段是进度水位，不是出处。出处在 observation 的 `sourceEntryIds`、reflection 的 `supportingObservationIds`。

两套尺子不要混：Observer / Reflector 优先用提供商回报的上下文用量（`getContextUsage`），没有才退回本地估算；**主动 compact 触发永远只用**上次压缩边界之后的原始 source token。改阈值时必须对上自己在动哪把尺子。

判定：触发成功只证明「准备跑后台任务」，不证明账本已更新。

### 5.2 Observer 收到未覆盖的 source 片段 → 调模型记账 → 产出 observations

输入被故意限制成原始条目（message / custom_message / branch_summary），序列化时带 entry id。Observer **不准**去读已经压过的摘要来编造记忆。

模型通过工具 `record_observations` 交卷。扩展会校验：content 非空、relevance 合法、`sourceEntryIds` 必须落在本 chunk 允许的 id 集合里。id 是内容的 sha256 前 12 位小写 hex。空数组不会落盘。

故意交白卷（没调用工具）和流式失败不是一回事：前者不写条目、打开 empty backoff（同一水位上不再连打），流水线**继续**进 Reflector；`ObserverStreamError`（stopReason 为 error/aborted 且什么都没记下）才整段中止，水位不推进。

载体：宿主进程内 `agentLoop`，异步。阶段异常记在 `Runtime.lastObserverError`，UI 可 notify。

### 5.3 Reflector 收到活跃 observations → 写结论 → 产出 reflections

Reflector 看的是折叠后的活跃池，不是原始对话。每条 reflection 必须引用至少一条仍活跃的 observation id，否则整批拒绝。

无输出或失败：本轮 **不跑 Dropper**。原因：Dropper 需要「刚被反射覆盖」的信号，才知道哪些 observation 可以从活跃池拿掉。没有这次覆盖，打墓碑会把还没升华的事件丢掉。

### 5.4 Dropper 收到同轮 reflections + 超标活跃池 → 按 id 打墓碑 → 产出 drops

门闩写死在 `runDropperStage`：没有 `sameRunReflectionCoverageId` 或本轮 reflections 为空，直接 `continue`。池子没超过 `observationsPoolTargetTokens` 也不跑。

Drop 是墓碑，不是物理删除。折叠时 dropped id 从**活跃池**消失，但 `foldLedger.observations` 仍保留首次有效记录；`recall` 仍能找到，状态标成 `dropped`。

Dropper 失败不会回滚已经追加的 reflections。这是当前可靠性边界：记账没有包住三阶段的总事务。

同步 / 异步切面：

```text
同步：读分支、看阈值、appendEntry
异步：三个 worker 的模型调用（同一进程，不挡宿主下一轮输入）
```

完成 ≠ 就绪：`om.observations.recorded` 已追加，只证明事件进了账本。它会不会出现在宿主下一轮看见的摘要里，要等下一次 compaction 投影。活跃池超标也要等「同轮反射成功」之后的 Dropper，不会立刻瘦身。

## 6. 纵向链路二：compaction 怎样把账本变成 Agent 看见的摘要

```text
agent_settled 发现 raw token 过阈值
→ 若空闲，调用 ctx.compact()
→ Pi 计算 firstKeptEntryId
→ session_before_compact 折叠并渲染
→ 非空：接管 summary / details
→ 空：return undefined，Pi 走原生 summarizer
```

### 6.1 主动触发层收到 agent_settled → 检查空闲与阈值 → 产出一次 ctx.compact()

故意挂在 `agent_settled` 而不是 `turn_end`：让 Pi 先做完自动重试、自动压缩、排队续跑。重试策略仍归 Pi。

`setTimeout(0)` 之后再查 `ctx.isIdle()`。Agent 又忙了，或这短暂间隙里已经压过一轮，就放弃。`compactAfterTokens` 默认按校准绝对值 81000；也可改成按模型窗口比例。

`ctx.compact()` 仍可能在进钩子之前失败——Pi 发现没有可裁的范围。扩展请求压缩 ≠ 压缩已经发生。

### 6.2 钩子收到 preparation + 当前分支 → 无模型投影 → 产出 summary 或放弃

`buildCompactionProjection` 按 `firstKeptEntryId` 决定折叠边界。活跃 observation 超过 `observationsPoolMaxTokens` 时裁剪；reflections 走另一条边界。结果塞进 compaction `details`（`type: om.folded`），summary 由 `renderSummary` 拼出固定说明 + `## Reflections` + `## Observations`。行格式带 `[id]`，供后续 `recall`。

投影为空（还没有任何有效 ledger）时钩子什么都不返回。不要把「扩展在场」理解成「每次压缩都由它写摘要」。早期会话、worker 还没成功记过一笔时，Pi 原生 summarizer 仍是正确的退路。

活跃 observation 的 token 合计一旦摸到 `observationsPoolMaxTokens`，投影改走 `fullFold`：连同本来会被维护边界挡住的 observations 一起折到 `firstKeptEntryId`。这是压缩时的池上限，不是 Dropper 的目标水位。

正在飞的压缩会取消后来的重复请求（`{ cancel: true }`），避免两个钩子抢同一轮。

可见记忆 vs 全量记忆：

| 词 | 含义 |
|---|---|
| 可见投影 | 最新一次 compaction details 里、Agent 当前能看见的那一份 |
| 全量折叠 | 把当前分支账本折到 tip（或指定边界），含尚未投影进去的新记录 |
| drift | `/om:status` 用 `diffProjection` 显示的「全量有、可见没有」 |

判定：compaction 成功只证明「宿主现在看见的摘要换了」。账本条目早就在 JSONL 里；没压过一轮，宿主也可能还没看见它们。

## 7. 纵向链路三：recall 怎样从账本找回证据

```text
宿主 Agent 决定需要原文
→ 调用 recall({ id })
→ 在当前分支按 12 位 hex 查找
→ 返回 observation / reflection / 混合命中
→ 附上 source entries；缺失则标 partial
```

这是同步工具，读的是 `ctx.sessionManager.getBranch()`，不调模型，不查外部库。已 drop 的 observation 仍然能召回，只是 status 为 `dropped`。找不到、id 不合法、source 条目已被压掉或类型不对，分别返回 `not_found` / `invalid_id` / `partial`。

`recall` 不是搜索。它要求精确 id。摘要里的 `[ab12cd34ef56]` 就是索引。不要把它理解成「语义检索上次聊过什么」——那是另一类扩展的工作。

## 8. 边界、概念区分与常见误区

| 词 | 是 | 不是 |
|---|---|---|
| Observation | 带时间戳、有 source 的事件记录 | 对话摘要的另一个名字 |
| Reflection | 由 observations 支撑的稳定结论 | 自动生成的 compaction 文本 |
| Drop | 活跃池墓碑 | 从 JSONL 删掉；不是不可召回 |
| `coversUpToId` | 进度水位 | 出处 / provenance |
| 可见记忆 | Agent 当前摘要里的投影 | 账本真相 |
| 全量折叠 | 分支 tip 的 ledger 真相 | Agent 已经看见的内容 |
| V3 ledger | 三种 customType 的可折叠记录 | V2 的 custom memory；V2 被忽略且不迁移 |
| `passive` | 不启动 worker、不自动 compact | 卸载扩展；钩子仍在 |

常见误区：

- 「装了这个扩展，压缩摘要就一定是它写的。」错。正：投影为空时主动放弃，Pi 原生 summarizer 接手。
- 「Dropper 会把记错的记忆删掉。」错。正：只把 id 移出活跃池；`recall` 仍在。
- 「Worker 在独立进程里，挂了不影响 Pi。」错。正：同一进程的 Promise。模型失败不会打崩宿主，但会占同一进程的事件循环和 API 额度。
- 「可以从旧 session 继承记忆。」错。正：账本在这次 session 的分支上。要跨会话，用别的扩展。
- 「升级 V3 会读旧 V2 设置。」错。正：旧 key 和旧条目被忽略。官方建议改设置后开新 session。

## 9. 失败形态与排错

当前没有包住 Observer / Reflector / Dropper / 落盘的总事务。这是可靠性边界。

| 失败位置 | 账本是否变化 | 进度水位 | 下次怎么处理 |
|---|---|---|---|
| 模型解析失败（没 apiKey 也没 headers） | 不变 | 不推进 | 跳过本阶段，notify 一次 |
| Observer 故意空跑 | 不变 | 不推进；打开 empty backoff | 同一水位上不再连打，流水线仍进 Reflector |
| Observer 流式失败 / 抛错 | 本轮可能部分已 append（工具已成功的批次） | 未成功的那一截不推进 | 流水线中止；下一轮从最新水位继续 |
| Reflector 无输出或失败 | observations 已在则保留 | 反射水位不推进 | Dropper 本轮不跑 |
| Dropper 失败 | reflections 已追加不回滚 | drop 不写 | 池子继续超标，等下一次成功反射 |
| 投影为空 | 不接管 summary | 与账本无关 | Pi 原生摘要 |
| `ctx.compact()` 找不到可裁范围 | 账本不变 | 不变 | 钩子根本进不去 |
| 重复 compact | `{ cancel: true }` | 不变 | 已有那一轮继续 |

症状式检查：

- **装了扩展，压缩摘要仍像 Pi 原生。** 先看 `/om:status` 账本是否为空，再看是否从未成功跑过 Observer。不要先怀疑钩子没注册。
- **活跃 observations 只涨不掉。** 先看本轮是否有成功的 `om.reflections.recorded`。Dropper 故意等反射。不要先怀疑 Dropper prompt。
- **摘要里有 id，`recall` 却 not_found。** 你可能在别的分支，或 id 不是 12 位 hex。recall 只看**当前分支**。
- **Worker 通知一直 skipped — model unavailable。** 核对记忆模型的 auth：OAuth 模型只有 headers 没有 apiKey 也必须被接受（见包内 `AGENTS.md`）。不要给 `resolveModel` 加死 `apiKey` 检查。
- **`passive` 开着还指望自动记账。** 环境变量和 settings 里任意一处把 passive 打开都会停工。

调试开关：`observational-memory.debugLog = true` 会写本地调试日志；`/om:status` 看水位、drift、飞行状态；`/om:view` 看折叠后的正文。

## 10. 总结：五条稳定事实

1. 这是 Pi 进程内扩展，不是服务、不是 CLI、不是 daemon。
2. 权威数据源是当前分支的 V3 ledger custom entries，不是 compaction 摘要，也不是外部数据库。
3. Observer / Reflector / Dropper 判断「记什么」；扩展判断「何时记、怎样折叠、压缩时怎样投影」。
4. Dropper 只在同轮反射成功之后才跑；drop 是墓碑，召回仍在。
5. 记账、投影、召回三条链路可以独立成败。投影为空必须让权给 Pi 原生 summarizer。

如果只记一条完整主线：

```text
Pi 会话 JSONL
→ 后台 worker 往分支上追加三种 custom entry
→ foldLedger 重建活跃记忆
→ compaction 无模型投影成宿主摘要
→ 宿主用 recall(id) 按需回到账本原文
```

## 11. 深入通道：源码阅读顺序

按调用链读，不要按文件名散读。

1. `src/index.ts` — 扩展装了什么：三条钩子、两个命令、一个工具，共用一个 `Runtime`。
2. `src/runtime.ts` — 飞行锁、配置加载、模型解析（apiKey **或** headers 即可）、worker 错误如何通知。
3. `src/hooks/consolidation-trigger.ts` — 整条记账流水线；重点看 Observer 失败即停、Dropper 的同轮反射门闩、`pi.appendEntry`。
4. `src/agents/observer/agent.ts`、`reflector/agent.ts`、`dropper/agent.ts` — 各用一个工具交卷；校验规则就是质量边界。
5. `src/session-ledger/fold.ts` → `projection.ts` → `render-summary.ts` — 真相如何重建、如何变成摘要、空投影如何产生。
6. `src/hooks/compaction-trigger.ts` 与 `compaction-hook.ts` — 谁发起 compact、谁填写载荷、何时 `{ cancel: true }`、何时放弃接管。
7. `src/session-ledger/recall.ts` 与 `src/tools/recall-observation.ts` — 已 drop 为何仍能召回；partial 是什么意思。
8. `src/config.ts` — 默认阈值、配置合并顺序、`compactAfterTokensMode`。
9. `src/commands/status.ts`、`view.ts` — 用用户能看见的表面，反推可见/全量/drift。

读完第 3–6 组，记账链路和压缩链路已经闭合。第 7 组把「摘要里的 id」连回证据。

二次开发时优先碰的缝：新的 customType 必须能被 `foldLedger` 理解，否则压缩投影看不见；不要让 Dropper 在没有同轮反射时跑；不要在 `resolveModel` 上恢复「必须有 apiKey」。
