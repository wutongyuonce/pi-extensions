# 看懂 pi-hermes-memory：跨会话 Markdown 记忆怎样被检索

> 本文面向已经会用 Pi、想搞清「记忆写在哪、默认为什么不塞进 system prompt、搜索打的是哪一层」的读者。需要知道 Pi 扩展是随宿主进程加载的。本文定位：二次开发深度（给到文件级阅读顺序，不逐类铺开）。
>
> 源码基线：本仓库 HEAD `6f1c21cebfdc0bf6b25657ff4f80005a6d40e517`（2026-09-08），包版本 `0.9.7`。上游：[chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)。移植自 [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent)。0.9 仍在长功能，稳定认知放在职责边界与数据流上。仓库根 `AGENTS.md` 仍写着「No SQLite / 记忆在 `~/.pi/agent/memory/`」，那是 v0.1 文档，**以 `src/index.ts` 为准**。

## 1. TLDR：它做的事情可以压成四条链路

Pi 默认关掉会话就忘。这个扩展补上跨会话的事实、偏好、失败教训，以及「以前哪次对话说过」。

```text
写入：
宿主 Agent 调用 memory_add（或后台 review / 纠正检测 / flush 代写）
→ 内容扫描挡住密钥和注入
→ 原子写入 MEMORY.md / USER.md / failures.md
→ 再同步进 sessions.db 的 memories 表

注入：
session_start 从磁盘加载
→ before_agent_start 拼 system prompt
→ 默认 policy-only：只注入「该怎么用记忆」的说明书 + 用户钉住的 STANDING.md
→ 不把 MEMORY.md 正文塞进 prompt

检索：
Agent 调用 memory_search 或 session_search
→ 打 SQLite FTS5（派生索引）
→ 命中的是记忆条目或历史会话消息，不是当场重读 Markdown

后台学习：
每约 10 个回合或 15 次工具调用（还要用户回合 ≥ 3、分支里至少 4 段）
→ 默认进程内 `completeSimple`：模型吐 JSON 操作，扩展代写 Markdown
→ 失败或配成 subprocess 才 `pi -p` 拉带子工具的无头 Pi
→ compact / shutdown 前再 flush 一次
```

所以它不是：

- 会话内 compaction 账本（那是 `pi-observational-memory`）
- 把全部记忆永远放进 system prompt 的「提示词记忆」
- 常驻 daemon / 独立记忆微服务
- 向量数据库；搜索是 SQLite FTS5，默认 trigram
- 让扩展自己理解对话写总结——「什么值得记」仍由模型判断

正面定义：它是寄生在 Pi 进程里的**跨会话记忆基板**。Markdown 文件是权威内容；SQLite 是派生索引；默认只把「如何使用记忆」的政策注入 prompt，真正的条目靠工具按需取。

职责边界：

| 谁 | 负责什么 | 不负责什么 |
|---|---|---|
| 宿主 Agent / 后台 review 模型 | 判断什么值得写、写到哪个 target | 不负责扫描、落盘、索引 |
| `MemoryStore` | `§` 分隔的 Markdown CRUD、字符上限、溢出策略 | 不负责 FTS 搜索 |
| 内容扫描 | 挡住 prompt 注入、角色劫持、密钥、不可见字符 | 不判断内容是否「重要」 |
| SQLite | 会话消息索引 + 记忆的可搜索副本 | 不是记忆正文的权威源 |
| `STANDING.md` | 用户钉死、每轮无条件注入的禁令/规则 | 后台 review 写不进去 |

权威数据源尽早说清：

```text
Markdown（MEMORY.md / USER.md / failures.md / STANDING.md / skills/*/SKILL.md）
        = 有界记忆的权威内容

Pi 自己的 session JSONL（~/.pi/agent/sessions/）
        = 对话原文的权威

sessions.db
        = 上面两者的派生索引，用来 search，不是用来当唯一真相
```

`memory_search` 能搜到、Markdown 里没有，是索引脏了。Markdown 有、search 没有，也是索引脏了。不要把两边当成两个权威。

## 2. 为什么默认不把记忆塞进 system prompt

Hermes 原版会把 MEMORY.md 冻进 system prompt。Pi 这边默认改成 `memoryMode: "policy-only"`。

原因不是「记忆不重要」，而是三条同时成立的约束：

1. Pi 的 prompt cache 很金贵。记忆一变就整段 cache 作废。
2. 记忆文件可以长到几千字符；每轮都塞，长会话先被自己的档案挤爆。
3. 禁令类规则如果只存在于「模型想起去 search」的路径上，模型在要做被禁止的事之前**恰恰不会去搜**。这不是模型质量问题，是结构问题。

所以拆成两层：

- **政策层**（默认注入）：告诉模型有记忆工具、该何时 `memory_search`、target 怎么选。
- **条目层**（默认不注入）：事实、偏好、失败教训放在 Markdown + SQLite，按需检索。
- **钉住层**（无条件注入）：`STANDING.md` 走单独存储。后台 review、consolidation、纠正检测都写不进去。只有用户 `/memory-pin` 或手改文件。

正例：用户偏好「用 pnpm」应当进 USER.md，下次靠 `memory_search` 取回。用户钉死「永远不要跑 rm -rf」应当进 STANDING.md，每轮都在。

反例：不要把整份 MEMORY.md 重新改回默认注入，除非你明确切换 `memoryMode` 为非 `policy-only`（文档和代码称这类为 legacy 注入）。也不要把 STANDING 当成「加个 flag 的 MEMORY 条目」——provenance 必须是存储结构，不能是字段。

## 3. 先看整体架构，不急着看类名

文档视角：

```text
接入层          Pi 扩展钩子 / 命令 / 工具
        ↓
策略与注入层     policy-only 说明书 · STANDING.md ·（可选）冻结的 Markdown 快照
        ↓
写入与扫描层     memory_add/replace/remove · 内容扫描 · 溢出合并
        ↓
权威存储层       全局 Markdown · 项目 Markdown · skills · STANDING.md
        ↓
派生索引层       sessions.db（memories FTS + messages FTS）
        ↓
检索层          memory_search · session_search
```

进程真相和文档视角大部分重合，差异是精华：

- 「Background Learning Loop」是代码职责，不是常驻 worker 进程。默认用宿主进程里的一次 `completeSimple` 短补全（解析 JSON 操作，不给这轮补全挂记忆工具）；失败或配置成 `subprocess` 才 `pi -p` 拉子进程，那时候子进程才真正调用 `memory_*`。
- 「Memory Service」不存在。没有监听端口的服务。
- SQLite 随扩展在 session 里打开，shutdown 时 checkpoint 再 close。不是独立数据库进程。

每一层收到什么 → 做什么 → 产出什么：

| 层 | 收到 | 做 | 产出 |
|---|---|---|---|
| 接入 | 生命周期事件、斜杠命令、工具调用 | 路由到 handler | 不解释内容 |
| 注入 | 已加载的 store + 配置 | 按 `memoryMode` 拼 prompt | 追加到 `event.systemPrompt` |
| 写入 | 模型给的文本 + target | 扫描 → 原子写 Markdown → 同步 SQLite | 成功/拒绝/溢出后合并 |
| 权威存储 | 文件 | 以 `§` 分隔的条目，temp+rename | 磁盘上的 md |
| 派生索引 | Markdown 变更或 session JSONL | FTS5 插入/更新 | 可搜索副本 |
| 后台学习 | 最近对话切片 | 另开一轮带记忆工具的模型 | 可能产生新的写入 |

## 4. 它主要是一个寄生扩展，偶尔才有子进程

`package.json` 的 `pi.extensions` 指向 `./src/index.ts`。`pi install npm:pi-hermes-memory` 之后随 Pi 会话加载。没有自己的 HTTP 服务，没有 cron。

```text
用户的 Pi 进程
├── 宿主 Agent
├── 本扩展（同一进程）
│   ├── MemoryStore / StandingInstructions / SkillStore
│   ├── DatabaseManager（better-sqlite3，文件 sessions.db）
│   ├── 钩子：session_start / before_agent_start / turn_end /
│   │         message_end / session_before_compact / session_shutdown
│   └── 工具：memory_add · memory_replace · memory_remove ·
│             memory_search · session_search · skill_manage
└── 可选子进程（reviewTransport=subprocess，或直连失败时的回退）
    └── `pi -p ...` 跑一轮带记忆工具的无头补全，写完同一批 Markdown
```

装了什么、跑起来是什么：

| 产物 | 路径（默认） | 角色 |
|---|---|---|
| 全局记忆目录 | `~/.pi/agent/pi-hermes-memory/` | 权威 Markdown + SQLite + 全局 skills |
| 旧目录 | `~/.pi/agent/memory/` | 仅迁移源，配置即使指向它也会被折回新根 |
| 项目记忆 | `~/.pi/agent/projects-memory/<项目名>/` | 仓库级 MEMORY.md / skills |
| 配置 | `~/.pi/agent/hermes-memory-config.json` | 不是 settings.json 里的命名空间 |
| 对话原文 | `~/.pi/agent/sessions/*.jsonl` | Pi 自己的 session 文件，扩展只建索引 |
| SQLite | `<全局记忆目录>/sessions.db` | 派生索引 |

项目名怎么来：`detectProject` 看 git 公共根（含 worktree），新目录用仓库名；若只有旧的 cwd-basename 目录则继续用旧名。工厂函数里**不准**用 `process.cwd()` 快照项目身份，必须等 `session_start` / 工具执行时的 `ctx.cwd`。

后台部分点名：

| 环节 | 载体 | 谁拉起 | 崩溃语义 |
|---|---|---|---|
| Background review | 默认进程内 `completeSimple` 解析 JSON；可子进程 | `turn_end`，满 N 回合或 M 次工具调用，且用户回合 ≥ 3、分支 ≥ 4 段 | `reviewInProgress` 防重入；失败本轮跳过；模型回「nothing to save」不回退子进程 |
| Correction save | 同上 | `turn_end`，用户上一句命中纠正模式 | 不等下一个 nudge 周期 |
| Session flush | 同上，超时更短 | `session_before_compact` / `session_shutdown`，且用户回合 ≥ `flushMinTurns`（默认 6） | shutdown 失败静默，不挡退出 |
| Auto-consolidation | 手动命令可走直连；MemoryStore 溢出触发的自动路径**只有子进程**（store 拿不到 modelRegistry） | 写入触顶且过了 180s grace | 子进程改磁盘后父进程必须 reload |
| Session backfill | 宿主进程内 `setTimeout(0)` | `session_start` 后，每启动最多 50 个未索引文件 | 失败 notify，不挡会话 |
| Live index | 宿主进程 | 每次 `message_end` | 失败 console.warn |
| Shutdown index | 宿主进程，注册在最后 | `session_shutdown` | 等 backfill/live 各最多 5s，再 close DB；WAL truncate |

被谁拉起的进程就归谁：子进程是无头 Pi，跑完退出。不要把它理解成守护进程。自动 consolidation 从 MemoryStore 触发时没有扩展上下文，所以这条路径不能走 direct。

## 5. 磁盘上到底谁说了算

```text
~/.pi/agent/pi-hermes-memory/
├── MEMORY.md          全局笔记（环境、工具事实）
├── USER.md            用户画像与偏好
├── failures.md        分类教训（failure/correction/insight/…）
├── STANDING.md        用户钉住的规则（模型写不进）
├── skills/            全局程序性技能
└── sessions.db        FTS 索引（派生）

~/.pi/agent/projects-memory/<name>/
├── MEMORY.md
└── skills/
```

Markdown 条目用 `\n§\n` 分隔，字符上限按文件计（默认各 5000，不是 token）。写入走 temp 文件 + `rename`。扫描在任何写入之前。

SQLite 表（稳定的是职责，列名可能变）：

| 表 | 存什么 | 权威？ |
|---|---|---|
| `memories` + `memory_fts` | 记忆条目的可搜索副本 | 否，跟 Markdown 对账 |
| `messages` + `message_fts` | 历史会话消息 | 否，权威是 JSONL |
| `sessions` / `session_files` | 索引进度（size/mtime） | 派生；用来增量 backfill |
| `extension_metadata` | 例如 FTS tokenizer 版本 | 内部 |

`memoryMode = policy-only` 时，Markdown 仍然写入、仍然进 SQLite，只是**不**把正文拼进 system prompt。不要把 policy-only 理解成「关闭记忆」。

Standing 的预算独立（条数和字符硬上限），避免 MEMORY.md 已经很长时用户钉一条禁令还要给整份档案付 token。

## 6. 纵向链路一：开会话时加载、迁移、注入

```text
session_start
→ 可能把旧 ~/.pi/agent/memory 迁到 pi-hermes-memory
→ 按 ctx.cwd 绑定项目 store
→ loadFromDisk（冻结快照）
→ 调度 session JSONL backfill（异步、有上限）
→ before_agent_start 追加 prompt
```

### 6.1 持久化初始化收到首次 session_start → 迁移与对账 → 产出可打开的 DB 和已加载 store

迁移失败、SQLite backfill 失败都被包在 try/catch 里，**不得挡住启动**。若 legacy `sessions.db` 还在迁移，DB 打开会被 guard 拦住，直到迁移成功。

`loadFromDisk` 之后，legacy 注入模式里 **MEMORY.md / USER.md 用冻结快照**：本会话后半段再写入，prompt 里那份不变（保 Pi 的 prompt cache）。例外要单独记：failures 按年龄过滤后**热读**；项目 MEMORY.md 也是**热读**（`formatProjectBlock`），所以项目记忆可以打断前缀 cache。policy-only 默认不把这三份正文塞进 prompt。`STANDING.md` 和 skills **不进 SQLite**。

判定：session_start 返回只证明扩展没把启动打崩。索引是否赶完要看 backfill 通知；prompt 里有没有条目要看 `memoryMode`。

### 6.2 注入层收到 systemPrompt → 按模式拼接 → 产出追加块

`buildPromptContext`：

- `policy-only`：政策说明书 + STANDING。政策 style 还可再缩成 compact / custom / none。
- 其他模式：冻结的 MEMORY + USER + 项目块 + STANDING。
- STANDING 在**所有模式**里都追加，包括政策 style `none`。这就是它存在的理由。

同步。不调模型。

## 7. 纵向链路二：一条记忆怎样落到磁盘和索引

```text
memory_add({ target, content, ... })
→ 解析 target（memory / user / project / failure）
→ scanContent：注入 / 密钥 / 不可见字符 → 拒绝
→ MemoryStore 写入对应 Markdown（原子）
→ 超限则按 overflow 策略：合并 / 拒绝 / fifo
→ sqlite-memory-store 插入或复用 memories 行
→ 工具结果返回给宿主
```

### 7.1 扫描层收到待写文本 → 匹配威胁与密钥 → 产出通过或错误串

扫描是写入闸门，不是建议。命中则这次 add/replace 失败，Markdown 不变。不要指望「模型自己不会写密钥」——闸门在工具执行路径上。

### 7.2 权威存储收到通过扫描的条目 → 追加或替换 → 产出新的 Markdown 文件

target 决定文件：`user` → USER.md，`memory` → 全局 MEMORY.md，`project` → 项目 MEMORY.md（没有项目则失败），`failure` → failures.md 并带 category。

同一段内容的替换/删除按规范化文本匹配。匹配错 target 时，工具会提示「在别的 target 里找到了，换那个再试」。

溢出：默认 `auto-consolidate`。grace 窗口内（默认 180s）写入直接报错、**不**拉模型；窗口过了才 consolidation。自动路径走子进程（MemoryStore 没有 modelRegistry）；`/memory-consolidate` 有模型上下文时可以走直连。合并成功后父进程必须 reload，再重试一次写入。没有包住「Markdown + SQLite + 合并」的总事务：合并失败时可能已经超限。这是可靠性边界。

Markdown 条目带 HTML 注释元数据（`created` / `last` / 可选 project hash）。分隔符是字面量 `\n§\n`，写入**不消毒**：正文里若自己含有这段分隔符，加载时会裂成多条。

### 7.3 索引层收到刚写入的条目 → upsert FTS → 产出可被 memory_search 命中的行

Markdown 成功、SQLite 失败：权威内容在，搜索暂时没有。反向：有人只改了 db 或只改了 md，对账命令 `/memory-sync-markdown` 就是为这个裂缝准备的。

完成 ≠ 可检索：`memory_add` 成功保证 Markdown 已改（权威）。FTS 同步失败时，下一句 `memory_search` 可能还搜不到。policy-only 下，成功也不等于已经出现在 system prompt 里。

## 8. 纵向链路三：后台怎样「自己决定写什么」

三条触发，写的是同一套工具，成败互相独立。

```text
nudge：turn_end 计数 → 满 10 回合或 15 次工具调用 → 短补全
纠正：message_end 记下用户原文 → turn_end 若像纠正 → 立刻短补全
flush：compact / shutdown 前，用户回合够数 → 再给模型一次保存机会
```

### 8.1 Review 收到对话切片 → 直连吐 JSON 或子进程调工具 → 产出零次或多次写入

默认 transport 是进程内 `completeSimple`，超时 120s，目的是保住父会话的 LLM cache。模型被要求输出 `{ operations: [{ action, target, content, ... }] }`（或围栏 JSON / 第一个 `{...}`）。扩展在父进程里 `applyReviewOperations`，走和 `memory_add` 同一套扫描、落盘、SQLite observer。

直连失败才回退子进程——子进程才是「带着 `memory_*` 工具的无头 Pi」。模型回「nothing to save」**不**回退，避免空跑还拉一次进程。`reviewEnabled: false` 整条关掉。

还要过两道门闩：用户回合数 ≥ 3、当前分支至少 4 段消息。不到点连 JSON 补全都不打。

### 8.2 纠正检测收到用户句 → 正则两段过滤 → 产出一次立即保存

强模式直接触发；弱模式还要后面跟着指令动词；负模式一票否决。这是启发式，不是 NLU。误触发和漏触发都是预期内噪声。命中后走和 review 同一套 direct/subprocess 写入（直连超时 30s），并且 best-effort 再 `addFailure(..., { category: "correction" })`。速率限制：每 3 个回合最多一次。不等下一个 nudge 周期。

### 8.3 Flush 收到 compact/shutdown → 若回合够 → 产出最后一次保存

`flushMinTurns` 默认 6，避免空会话也花钱。shutdown 且 `reason === "reload"` 时不 flush。compact 上的 flush 超时 30s，shutdown 上 10s。索引和 `db.close()` 注册在最后——Pi 对同一扩展的 handler 按注册序 await。不要再在 close 之后挂一个写 DB 的 shutdown 钩子，它会静默空转。

同步 / 异步：触发是事件回调；模型调用异步。shutdown 不等待 review 完美结束，只 best-effort 等索引。

判定：nudge 到点 ≠ 记忆已更新。模型可以看完什么都不写。要确认得看 Markdown 或 `/memory-insights`。

## 9. 纵向链路四：检索打的是索引，不是文件

```text
memory_search(query, target/project/category)
→ SQLite memory_fts
→ 返回条目文本

session_search(query, ...)
→ 默认：SQLite message_fts（历史对话）
→ 可选 anchors：直接扫 JSONL，返回 path:startLine-endLine
```

两条工具不要混：

| | memory_search | session_search |
|---|---|---|
| 问的问题 | 「我们约定过什么」 | 「哪次对话提到过 auth」 |
| 数据 | memories 表 | messages 表或 JSONL 锚点 |
| 权威源 | Markdown | Pi session JSONL |
| 空库提示 | 还没有 extended memory | 还没有索引完会话 |

FTS 用 trigram tokenizer（元数据键 `fts5_tokenizer_version=trigram-v1`）。三字符以下默认不进 trigram 索引；`memory_search` 对 1–2 字中文走 `LIKE` 回退。没有独立中文分词服务。查询语法失败会再降级构造，不把原始用户字符串直接当 FTS 表达式硬灌。

`session_search` 的 anchors 变体**不读 SQLite**，回 JSONL 行号。适合「去那次会话里看原话」，不适合当摘要接口。

索引进度：启动 backfill 有 50 文件上限；其余下次再扫。`session_files` 用 size/mtime 跳过未变文件。所以「昨天的对话搜不到」先看是否还在 backfill 队列，不要先怀疑 FTS 坏了。

## 10. 边界、概念区分与常见误区

| 词 | 是 | 不是 |
|---|---|---|
| policy-only | 不把条目注入 prompt，工具仍可读写 | 关闭记忆 |
| legacy 注入 | 冻结快照进 system prompt | 每轮热更新 prompt |
| STANDING.md | 用户钉住、无条件注入；不进 SQLite | 带 pin 标记的普通记忆 |
| MEMORY.md | 有界权威正文 | 搜索索引 |
| sessions.db | 派生 FTS | 记忆真相 |
| 全局 vs 项目 | 两套目录，target 分流 | 同一文件里的两个 section |
| skill | 可复用步骤，SKILL.md | 一条 MEMORY 备注 |
| review | 周期性短补全 | 常驻 daemon |
| observational-memory | 会话内 compaction 账本 | 本扩展的别名 |

常见误区：

- 「默认会把我的偏好每轮放进 prompt。」错。正：默认只有政策和 STANDING；偏好靠 `memory_search`。
- 「搜不到就是没存上。」错。正：先看 Markdown 有没有。有则是索引问题；没有则是模型没写或扫描拒绝。
- 「后台 review 在独立守护进程里。」错。正：默认就是宿主进程里一次补全。
- 「AGENTS.md 说没有 SQLite。」错。正：那是过期的 v0.1 描述。现在有 `sessions.db`。
- 「项目记忆跟 cwd 绑定成死的。」错。正：跟 git 公共根走，worktree 共享；绑定时机是 session/tool 的 cwd，不是扩展工厂。
- 「consolidation 失败会回滚到写入前。」错。正：没有总事务。文件可能已经超限。

## 11. 失败形态与排错

没有包住「扫描 + Markdown + SQLite + 合并」的总事务。这是当前可靠性边界。

| 失败位置 | Markdown | SQLite | 下次 |
|---|---|---|---|
| 扫描拒绝 | 不变 | 不变 | 改内容再写 |
| Markdown 写入失败 | 不变 | 不变 | 重试 |
| Markdown 成功、SQLite 失败 | 已变 | 可能落后 | `/memory-sync-markdown` |
| 自动合并失败 | 可能仍超限 | 不一定 | grace 后再试；可手动 `/memory-consolidate` |
| review 模型失败 | 不变 | 不变 | 下个 nudge |
| flush 在 shutdown 失败 | 可能没赶上 | shutdown 仍 close DB | 静默；不挡退出 |
| DB 损坏 | 权威仍在 md | 尝试 rebuild / 空库 | 有 backup 路径 |
| FTS tokenizer 迁移锁失败 | 不变 | 可能暂不可搜 | 下一次打开再迁 |
| better-sqlite3 ABI 对不上（换过 Node） | 权威仍在 md | 打不开 | `npm rebuild better-sqlite3`；工厂惰性加载，避免 import 即崩 |
| 正文含字面量分隔符 | 加载时裂成多条 | 跟着裂 | 没有转义；条目里不要写 `\n§\n` |

症状式检查：

- **资源能列，语义搜索为空。** 先 `/memory-insights` 看 Markdown 计数，再看 `sessions.db` 是否存在、backfill 是否报过错。不要先怀疑 prompt 没注入——policy-only 本来就不注入条目。
- **刚 `memory_add` 成功，search 没有。** 先假定 SQLite 同步失败，跑对账命令。不要先假定 FTS 中文不行（trigram 在）。
- **STANDING 钉了但模型还是做了禁止的事。** 看 `/memory-preview-context` 是否真的拼进去、是否被截断（有 omittedCount）。不要先去 MEMORY.md 里找这条。
- **项目记忆写到了全局。** 查当时 cwd 是否被识别为 git 项目、`/memory-switch-project` 列表。工厂里的 process.cwd() 不是绑定源。
- **子进程 consolidation 跑完，父会话仍报超限。** 父进程必须 reload。自动路径注释里写了这条。不要只看子进程退出码。
- **OAuth 模型的 review 起不来。** 直连补全需要能把 headers-only auth 传下去；auth 被拒会转一次 key、再不行才回退子进程。不要只查 apiKey。
- **扩展加载报 better-sqlite3 / NODE_MODULE_VERSION。** 先 rebuild native 模块，不是记忆格式坏了。DB 是惰性打开的，工厂 import 本身不该崩。
- **搜不到两个字的中文。** trigram 默认忽略短于 3 的 token；`memory_search` 有 LIKE 回退，`session_search` 的短词回退不是同一条路径。

## 12. 总结：五条稳定事实

1. 这是 Pi 进程内扩展；后台学习默认也在同一进程，子进程只是回退。
2. Markdown 是有界记忆的权威；`sessions.db` 是派生索引；Pi 的 session JSONL 是对话原文的权威。
3. 默认 `policy-only`：prompt 里是使用说明书 + STANDING，不是 MEMORY.md 正文。
4. 「记什么」由模型判断；扩展负责扫描、落盘、溢出、索引、检索。
5. 写入、后台 review、flush、会话索引四条链路可以独立成败。工具成功 ≠ 已进 prompt，也 ≠ 一定能搜到。

如果只记一条完整主线：

```text
模型决定写
→ 扫描
→ Markdown 权威落盘
→ SQLite 派生索引
→ 下次会话：政策 + STANDING 进 prompt，条目靠 memory_search / session_search 按需取回
```

## 13. 深入通道：源码阅读顺序

1. `src/index.ts` — 扩展工厂：目录根、迁移、store 装配、钩子注册顺序（shutdown close 必须最后）。
2. `src/paths.ts`、`src/project.ts`、`src/config.ts` — 磁盘根、项目识别、`hermes-memory-config.json` 默认值（尤其 `memoryMode` 和 `reviewTransport`）。
3. `src/prompt-context.ts`、`src/store/standing-instructions.ts` — 为什么 STANDING 必须独立、为什么 policy-only 仍要注入它。
4. `src/store/memory-store.ts`、`src/store/content-scanner.ts` — 权威写入、`§`、上限、溢出 grace、扫描闸门。
5. `src/tools/memory-tool.ts`、`src/store/sqlite-memory-store.ts` — 工具层如何在 Markdown 成功后 sync 索引。
6. `src/handlers/background-review.ts`、`session-flush.ts`、`correction-detector.ts`、`review-memory-ops.ts`、`pi-child-process.ts` — 三条学习触发如何共享直连/子进程运输。
7. `src/handlers/auto-consolidate.ts` — 为什么自动合并拿不到 direct、为什么父进程要 reload。
8. `src/store/schema.ts`、`src/store/db.ts`、`src/store/session-indexer.ts`、`src/handlers/session-backfill.ts`、`session-live-index.ts` — 派生索引何时建、何时赶不上。
9. `src/tools/memory-search-tool.ts`、`src/tools/session-search-tool.ts` — 两条搜索的数据源差异；legacy vs anchors。
10. `src/tools/skill-tool.ts`、`src/store/skill-store.ts` — 程序性记忆如何与事实记忆分家。

读完 1–5，权威源和默认不注入已经闭合。6–7 是学习回路。8–9 是「为什么搜得到/搜不到」。根目录 `AGENTS.md` 和 `docs/ROADMAP.md` 的「当前阶段」以代码为准，阶段编号已经落后于 0.9.7。

二次开发时优先碰的缝：新增写入路径必须过 `scanContent` 且不能写 STANDING；新增 shutdown 钩子不要放在 DB close 之后；不要把 FTS 当成权威；不要在工厂里用 `process.cwd()` 绑项目。
