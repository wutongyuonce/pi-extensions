# 看懂 pi-memory：Markdown 档案默认冻进 system prompt

> 本文面向已经会用 Pi、想搞清「这个扩展把记忆写在哪、每轮塞进 prompt 的是文件还是搜索结果、和另外两套记忆扩展差在哪」的读者。需要知道 Pi 扩展是随宿主进程加载的。
>
> **本文定位：二次开发深度。** 稳定认知放在职责边界、权威文件、快照检查点上。截断上限、超时毫秒、提示文案属于易变细节。
>
> 源码基线：本仓库 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），包版本 `0.4.2`；该目录最近一次提交 `262c13e`（2026-09-03）。上游：[jayzeng/pi-memory](https://github.com/jayzeng/pi-memory)。搜索引擎：[tobi/qmd](https://github.com/tobi/qmd)。灵感来源：[skyfallsin/pi-mem](https://github.com/skyfallsin/pi-mem)。
>
> 同目录另外两篇不要混读：[`看懂 pi-hermes-memory.md`](./看懂%20pi-hermes-memory.md) 讲「Markdown 权威 + SQLite 派生索引、默认不注入条目」；[`看懂 pi-observational-memory.md`](./看懂%20pi-observational-memory.md) 讲「会话内账本撑过 compaction」。本文只讲 `pi-memory`：明文文件、默认注入、可选 qmd。

## 1. TLDR：它做的事情可以压成三条链路

Pi 默认关掉会话就忘。`pi-memory` 把跨会话该留下的东西写成三份 Markdown，再在每一轮开始前把一份**截断后的快照**接到 system prompt 后面。搜索是可选的外挂，不是权威。

写入（模型主动，同步落盘）：

```text
用户说「记住…」/ 模型自己判断该记
  → memory_write / scratchpad / memory_forget
  → 写 ~/.pi/agent/memory/ 下的 md（或 recovery/*.json）
  → 500ms 后后台 qmd update + embed（可关）
  → 文件已在磁盘 ≠ 下一轮快照一定刷新
```

注入（每轮自动，改的是 prompt 字符串）：

```text
before_agent_start
  → 默认 stable：复用检查点拍下的快照
  → 可选 per-turn：用当前 prompt 去 qmd 搜一轮再拼
  → 拼进 event.systemPrompt 后返回
```

会话边界（压缩 / 退出，各写 daily 一笔）：

```text
compaction → 把未完成 scratchpad + 今日 daily 尾巴写成 HANDOFF
退出（Ctrl+D / /quit / session-end）→ 另开一次 LLM 写 Session Summary
  → 写进今日 daily
  → 完成 ≠ 一定落盘（消息太少、全是 None.、超时、lifecycle 跳过）
```

所以它不是：

- **不是** `pi-hermes-memory`。那边默认 `policy-only`，条目要靠 `memory_search` 取；这边默认把截断后的 MEMORY.md / 今日+昨日 daily / 未完成 scratchpad **冻进每一轮**。
- **不是** `pi-observational-memory`。那边的权威在 session 分支的 custom entries，跨会话带不走；这边的权威是磁盘上的 Markdown，换会话还在。
- **不是** 向量数据库。权威是明文文件。qmd 的 BM25 / 语义 / hybrid 是派生索引，搜得到、文件里没有，是索引脏了。
- **不是** daemon / 独立 MemoryService。没有常驻进程；扩展跟着 Pi 进程活，qmd 是按需 spawn 的 CLI 孩子。
- **不是** 把整份档案原样塞进 prompt。每段有行数/字符上限，总上下文 16 000 字符封顶。

正面定义：它是挂在 Pi 上的 **跨会话明文记忆层**——模型（和用户）写 Markdown，扩展负责截断、在检查点拍快照、可选地用 qmd 做搜索。

权威数据源尽早说清：

```text
MEMORY.md / SCRATCHPAD.md / daily/YYYY-MM-DD.md
        = 记忆内容的权威（人手可改、可 commit）

recovery/<uuid>.json
        = forget 删除块的权威备份，restore 只认这里

注入进 system prompt 的快照
        = 截断后的视图，不是权威

qmd collection「pi-memory」
        = 派生索引，用来 search，不是用来当唯一真相
```

## 2. 为什么默认要把文件冻进 prompt

三套记忆扩展面对的是同一句抱怨：「Agent 不记得上次的决定」。它们给出的结构答案不一样。

`pi-memory` 的判断是：编码 Agent 最该记住的那几类东西——偏好、决策、今天还没做完的清单——如果只存在于「模型想起去搜」的路径上，模型在该用它们之前**恰恰不会去搜**。所以默认走注入，而不是默认走检索。

正例：用户说「我们用 pnpm、永远不要 yarn」。应当 `memory_write` 进 MEMORY.md。下一会话第一轮，截断后的 MEMORY.md 已经在 system prompt 里，不必先调 `memory_search`。

反例：不要指望它记住**这一次会话里刚发生、还没写成文件**的中间状态——那是 `pi-observational-memory` 的账本。也不要把禁令类规则只写进 daily 尾巴指望模型每轮都看见：daily 注入是「end」截断，中间段落会被丢掉；hermes 的 `STANDING.md` 才是「钉死、不可被后台改写」那一层，`pi-memory` **没有**这一层。

和另外两套的职责切面（不要平均）：

```text
pi-memory                 跨会话明文档案；默认注入截断快照；qmd 可选
pi-hermes-memory          跨会话 Markdown + SQLite FTS；默认不注入条目；STANDING 钉死
pi-observational-memory   会话内账本；compaction 时投影；跨会话带不走
```

同一台机器可以都装。它们写的不是同一份权威：`pi-memory` 默认目录是 `~/.pi/agent/memory/`，hermes 也常用这个目录名，**不要假定可以共用同一份 MEMORY.md**——文件名碰巧撞上不等于格式兼容。

所以架构判断是：

```text
模型（和用户）管「记什么」（质量）
扩展管「何时注入、截哪一段、何时 spawn qmd」（流程）
Markdown 文件是交接结果（权威）
快照和 qmd 索引都是派生
```

## 3. 先看整体架构，不急着看类名

文档视角的职责分层：

```text
接入层          Pi 钩子（session_start / before_agent_start / compact / shutdown）
                + 七个工具
        ↓
注入策略层      stable 快照（默认） / per-turn 现搜现拼（opt-in）
        ↓
文件层          MEMORY.md · SCRATCHPAD.md · daily/*.md · recovery/*.json
        ↓
派生搜索层      qmd collection「pi-memory」→ keyword / semantic / deep
        ↓
会话边界层      compact 写 HANDOFF · shutdown 写 Session Summary
```

进程真相和文档视角大部分重合，差异是精华：

- **没有**「Memory 服务进程」。`index.ts` 的 default export 被 Pi 加载进当前进程。文件 I/O 是 `fs.writeFileSync`，发生在工具 `execute` 和钩子回调里，跟这一轮工具调用同步。
- qmd **不是**扩展内部的库。`detectQmd` / `runQmdSearch` / `scheduleQmdUpdate` 都是 `execFile("qmd", …)`。Windows 上会改成 `node <qmd.js>`，因为 `.cmd` 包装在非 shell spawn 下会炸。
- `session_start` 里的 catch-up `qmd embed` 是后台的：会话已经能聊了，嵌入可能还在跑。**会话已开始 ≠ 语义搜索已就绪**。
- `postinstall.cjs` **不**安装 qmd。开发 checkout 才配 git hooks；终端用户第一次开会话，没装 qmd 只会 `ui.notify` 一串安装说明。

## 4. 运行形态：单文件扩展 + 按需 CLI 孩子

它主要是一个 Pi 扩展，入口在 `package.json` 的 `pi.extensions: ["./index.ts"]`。Pi 直接加载 TypeScript，没有 build 产物，没有自己的 HTTP 端口。

```text
pi 进程
  ├─ 加载 index.ts（扩展，常驻到 pi 退出）
  ├─ 钩子回调里读/写 ~/.pi/agent/memory/
  └─ 需要搜索/更新索引时 spawn：qmd [search|update|embed|collection|context]
        └─ qmd 自己的模型下载/嵌入（第一次可能很慢）
```

谁拉起：用户 `pi install npm:pi-memory` 或 `pi -e ./index.ts`。谁保活：没有。Pi 退出，扩展退出；debounce 里还没跑的 `qmd update` 会被 `session_shutdown` 清掉。

目录解析：`PI_MEMORY_DIR` 优先，否则 `HOME` / `USERPROFILE` / `HOMEDRIVE+HOMEPATH`，拼 `~/.pi/agent/memory`。测试用 `_setBaseDir` 改这五个路径常量，生产路径不要在工厂里用 `process.cwd()` 绑项目——这个扩展**没有**项目级记忆，全局一份。

日期用**本地日历日**，不用 UTC。`toISOString()` 会把 PDT 下午 5 点之后的写入记到「明天」的 daily，注入时今日日志对不上文件。这是 0.4.0 修过的坑，二次开发不要改回去。

和 hermes / observational 的进程对比：三者都是「寄生在 Pi 进程里的扩展」，都不是 `systemctl start` 的服务。差别在权威落在哪、默认同步进 prompt 的是什么。

## 5. 纵向链路一：记住一件事，下一轮看不看得见

语义层（完成 ≠ 就绪标在节点上）：

```text
1. 宿主层     用户/模型决定「该记」          同步，Pi 回合内
2. 工具层     memory_write / scratchpad      同步 execute
3. 落盘层     追加带 <!-- ts [sid] --> 的块  同步 fs.writeFileSync
4. 脏标记层   仅 long_term 把 snapshotDirty=true
              daily 故意不标脏               同步，但策略选择
5. 快照层     下一轮 before_agent_start
              看见 dirty / 跨日 / 无快照才 refresh
6. 索引层     scheduleQmdUpdate（500ms）
              → qmd update → ensureQmdEmbed  异步，可关
```

`memory_write` 两个 target：

- `long_term`：MEMORY.md。`append`（默认）在文件末尾加时间戳注释 + 内容；`overwrite` 整文件替换，只留一条 `last updated` 注释。
- `daily`：永远追加到今日 `daily/YYYY-MM-DD.md`，没有 overwrite。

scratchpad 是另一份文件、另一个工具。`add` / `done` / `undo` / `clear_done`。解析器只认 `- [ ]` / `- [x]` 这一行；0.4.0 之后 mutation **不再**整文件从 checklist 重建，手写标题、注释、子 bullet 会留下。注入时只带 **未完成** 项。

完成 ≠ 就绪的三处：

1. **daily 已写入 ≠ 快照已更新。** 注释写明：daily 是高频的，内容已经在 tool-call 历史里，故意不标 dirty。stable 模式下，刚写进今日日志的句子要等到 compact / 跨日 / 下次 session_start 才进快照。
2. **文件已写入 ≠ qmd 搜得到。** 500ms debounce，embed 还可能排队（`embedInFlight` + `embedPending`）。`PI_MEMORY_QMD_UPDATE=off|manual` 时索引完全不自动更新。
3. **快照已注入 ≠ 文件全文在 prompt 里。** scratchpad 头截、daily 尾截、MEMORY.md 中间截（留头尾丢中间）、总长 16 000。超了的部分只存在于磁盘。

`memory_forget` 按大小写不敏感子串删「生成条目」（从一条 `<!-- ts [sid] -->` 到下一条）。删之前把完整块写进 `recovery/<uuid>.json`，工具返回里能看见这个 ID。`memory_restore` 只认这份 JSON，追加回原文件，**不**覆盖后来的写入。scratchpad 没有 forget/restore。

## 6. 纵向链路二：每轮注入，以及可选的现搜现拼

默认 `PI_MEMORY_SNAPSHOT=stable`（Option P：为 KV cache 稳定着想）。检查点是：

```text
session_start
session_before_compact          （finally 里无条件 refresh，即使没写 HANDOFF）
long_term 写入后的下一轮        （snapshotDirty）
本地日期翻过一天                （snapshotTakenOnDate !== today）
```

`refreshMemorySnapshot` 调 `buildMemoryContext("")`——注意空字符串，**stable 路径不跑自动检索**。拼装优先级：

```text
未完成 scratchpad
  → 今日 daily（尾）
  → （仅 per-turn）qmd 搜到的「Relevant memories」
  → MEMORY.md（中间截）
  → 昨日 daily（尾）
```

拼好之后还加一段 caveat：快照是何时、因何拍的；权威请用 `memory_read` / `memory_search`。这是在承认视图会落后于磁盘。

`PI_MEMORY_SNAPSHOT=per-turn` 才走 `searchRelevantMemories(event.prompt)`。查询会剥控制字符、截到 200 字，再 `qmd search`。`PI_MEMORY_NO_SEARCH=1` 关掉这一步。`design.md` 仍按「每轮自动检索」写，**那是旧默认**；以 `getSnapshotMode()` 为准。

`memory_search` 工具本身始终走 qmd，和快照模式无关。mode 大致是 keyword / semantic / deep（hybrid）。没装 qmd、没有 collection、embeddings 还没好，会返回带安装说明的错误，而不是静默空结果。`memory_status` 是医生工具：文件库存、qmd 在不在、collection 在不在、embeddings 探测、当前 env。

## 7. 纵向链路三：压缩交接，以及退出摘要

compaction 前（`session_before_compact`）：

```text
读未完成 scratchpad + 今日 daily 最后 15 行
  → 两者都空：不写文件，但 finally 仍 refresh 快照
  → 否则追加 ## Session Handoff 到今日 daily
  → scheduleQmdUpdate（异步）
```

为什么 compact 即使没写 HANDOFF 也要 refresh：压缩会丢掉 tool-call 历史。若不拍新快照，已经 `done` 掉的 scratchpad 项还会按旧快照继续注入。

退出摘要（`session_shutdown`）是另一条链，**会再打一次模型**：

```text
判定原因：Ctrl+D（空闲且编辑器为空）/ 输入恰好是 /quit / 其它 session-end
  → 跳过：/reload /new /resume /fork（除非 PI_MEMORY_SUMMARIZE_TRANSITIONS=1）
  → 或 PI_MEMORY_EXIT_SUMMARY=0
  → 否则 generateExitSummary：会话消息 < 4 条直接放弃
  → complete()，自设超时默认 10s（Pi 核心等 shutdown 没有超时）
  → 全文「None.」不落盘
  → 否则追加 ## Session Summary (auto, exit: …) 到今日 daily
  → runQmdUpdateNow（shutdown 路径等 update，但不链式 embed）
```

完成 ≠ 就绪：摘要 LLM 成功返回，如果每节都是 None.，文件不会变。超时则什么都不写，迟到的结果丢弃。lifecycle 跳过时连 debounce 里未跑的 `qmd update` 也会被清掉——这是故意的，避免 `/reload` 卡住。

模型默认用当前会话模型，可用 `PI_MEMORY_EXIT_SUMMARY_MODEL=provider/model-id` 换成更便宜的；解析失败回退会话模型并 warn。

## 8. 边界、概念区分、常见误区

**文件 vs 快照 vs 索引。** 改 MEMORY.md 用手改编辑器，磁盘立刻变了；stable 快照要等下一个检查点；qmd 还要再等 update/embed。三层都「有这份记忆」是三种不同的命题。

**注入 vs 检索。** 本扩展默认注入截断文件；hermes 默认只注入政策说明书。不要把 hermes 笔记里的「为什么默认不塞」套到这里——两边做了相反的产品判断，各自自洽。

**跨会话 vs 会话内。** 本扩展的 daily/MEMORY 换 session、换 compact 都还在。observational 的 ledger 活在 session 分支里，换会话就没了。compaction 时本扩展写的是 daily 里一段 HANDOFF 文本，不是 custom entry。

**全局一份，没有项目记忆。** 没有 `projects/<id>/MEMORY.md`。多仓库共用同一份偏好——这是功能，也是污染面。

**qmd 不是依赖。** 核心 write/read/scratchpad/forget/restore 没 qmd 也能跑。`memory_search` 和 per-turn 自动检索才需要。`probeEmbeddings` 的 `"ready"` 只表示一次探测 query 没打出 “need embeddings”，**不**证明索引里有你刚写的那条。

常见误区：

1. 「装了 pi-memory 就等于装了记忆数据库。」没有数据库。去 `~/.pi/agent/memory/` 看文件。
2. 「刚 `memory_write` 到 daily，下一句模型一定能从 Memory 段读到。」stable 下读不到，除非你切 per-turn 或等到检查点。
3. 「`design.md` 写每轮自动检索，所以默认会搜。」代码默认 stable，空字符串进 `buildMemoryContext`。
4. 「和 hermes 都写 `~/.pi/agent/memory/`，可以共用。」格式、工具名、注入策略都不同；共用是数据损坏的捷径。
5. 「exit summary 失败会写一条 None. 占位。」0.4.2 起不会。旧行为会污染每日注入和 qmd。

## 9. 失败形态（现象 → 该查哪一层）

| 现象 | 先查 |
| --- | --- |
| 新会话完全不记得偏好 | MEMORY.md 是否真有那条；快照是否空；`PI_MEMORY_DIR` 是否指到另一份目录 |
| 记得旧的、不记得刚写的 daily | 是不是还没到检查点（§5 脏标记） |
| `memory_search` 报需要 qmd | `memory_status`；PATH 上有没有 `qmd`；Windows 是否解析到 `qmd.js` |
| 语义搜不到刚写的 | embed 是否还在飞；`PI_MEMORY_QMD_UPDATE` 是否 off；collection 名是不是 `pi-memory` |
| `/quit` 很慢 | 退出摘要在等 LLM；默认 10s 上限；可 `PI_MEMORY_EXIT_SUMMARY=0` |
| `/reload` 变慢 | 是不是设了 `PI_MEMORY_SUMMARIZE_TRANSITIONS=1` |
| 晚上写的 daily 跑到「明天」 | 是否有人把 `todayStr` 改回 UTC |
| forget 删多了 | `recovery/<id>.json` + `memory_restore`，不要手改 MEMORY.md 指望对得上块边界 |

## 10. 总结：五条稳定事实 + 一条主线

1. 权威是 `~/.pi/agent/memory/` 下的 Markdown（外加 `recovery/*.json`），不是 qmd，不是 prompt 里那截快照。
2. 默认 `stable`：检查点拍快照，每轮复用；`per-turn` 才现搜现拼。daily 写入不标脏。
3. 扩展寄生在 Pi 进程；qmd 是按需 CLI 孩子；没有 Memory daemon。
4. compact 写 HANDOFF、shutdown 写 Session Summary，两条都追加到今日 daily；摘要有跳过/超时/空内容三道门。
5. 和 hermes（默认不注入条目 + SQLite 索引 + STANDING）、observational（会话内账本）不是同一个问题的三个实现，是三个问题。

主线：

```text
模型/用户写 Markdown
  → 磁盘为权威
  → 检查点拍截断快照 → 每轮冻进 system prompt
  → （可选）qmd 派生索引给人按需搜
  → compact / 退出再往 daily 追加一段交接
```

## 11. 深入通道：源码阅读顺序

单文件项目，按**关心的问题**跳，不要从头看到 2400 行。

1. `index.ts` 文件头注释 + `resolveMemoryDir` / 五个路径常量  
   看了能懂：权威目录长什么样，测试如何改路径。
2. `buildMemoryContext` + `formatContextSection` 的上限常量  
   看了能懂：每轮模型实际能看见哪一段、哪种截断。
3. `getSnapshotMode` / `refreshMemorySnapshot` / `before_agent_start` 钩子  
   看了能懂：stable vs per-turn，dirty / 跨日 / compact 三个刷新由头。
4. `memory_write` 的 `execute`（long_term 标脏、daily 不标）  
   看了能懂：为什么「写了但下一轮 Memory 段没有」。
5. `session_before_compact` 整段（含 finally refresh）  
   看了能懂：HANDOFF 不是 compaction summary，快照为什么无条件重拍。
6. `generateExitSummary` + `session_shutdown` + `isExitSummaryEmpty` + `shouldSkipExitSummaryForReason`  
   看了能懂：退出为什么会打模型、什么情况故意不写。
7. `scheduleQmdUpdate` / `ensureQmdEmbed` / `runQmdSearch` / `buildQmdSpawn`  
   看了能懂：索引是孩子进程、Windows 为什么走 node、embed 排队。
8. `forgetBlocks` + `memory_forget` / `memory_restore`  
   看了能懂：删除的块边界、recovery 为什么是权威备份。
9. `test/unit.test.ts` 里 `buildMemoryContext`、snapshot、exit-summary 相关 describe  
   看了能懂：合同比 README 准。`design.md` 和默认注入策略冲突时以测试为准。

本地冒烟：`pi -p -e ./index.ts "remember: I prefer dark mode"`，然后 `cat ~/.pi/agent/memory/MEMORY.md`。再开一轮看 system prompt 里是否出现那句（stable 下 session_start 已拍过快照，应当在）。搜则另说：没 qmd 时 `memory_search` 应该报安装说明，而不是装成「没有记忆」。

二次开发时优先碰的缝：新增写入路径要决定是否 `snapshotDirty`；新增 shutdown 工作必须自带超时；不要把 qmd 输出当成权威；不要引入项目级目录却仍用全局快照注入。

## 参考资料

- [pi-memory README](https://github.com/jayzeng/pi-memory)
- 包内 `design.md`（设计动机仍有用；默认注入策略以代码为准）
- [qmd](https://github.com/tobi/qmd)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- 本仓库 [`看懂 pi-hermes-memory.md`](./看懂%20pi-hermes-memory.md)、[`看懂 pi-observational-memory.md`](./看懂%20pi-observational-memory.md)
