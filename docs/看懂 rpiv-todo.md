# 看懂 rpiv-todo：任务列表为什么能活过 /reload

> 面向第一次接触这个扩展、准备二次开发的读者。不需要先会 Pi 的 TUI API，但需要知道「会话分支」（session branch）是 Pi 把一轮轮消息存下来的那条链。
>
> 本文定位：**轻量扩展 + 二次开发深度**。稳定认知放在「谁是权威源、面板只是视图、按会话隔离」。快捷键默认值、文案、`maxWidgetLines` 会变。
>
> 源码基线：本仓库归档副本 `@rpiv/rpiv-todo`，包版本 **2.9.0**；归档仓库 HEAD `6f1c21c`（2026-09-08）。上游：[juicesharp/rpiv-mono `packages/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)。
>
> 工具名必须是 `todo`、面板 key 必须是 `rpiv-todos`。这不是品味问题：旧会话要靠这两个字符串回放。源码写明抽自 `rpiv-pi@7525a5d`，名字原样保留。

## 1. TLDR：它给模型一张能被你看见的任务表

rpiv-todo 做的事情可以压缩成三条链路：

```text
写入：
模型调用 todo 工具
→ 纯函数算出新快照
→ 写入当前会话的内存格子
→ 把完整快照塞进 toolResult.details
→ Pi 把这条结果记进会话分支

回放：
/reload、压缩、切会话树
→ 顺着当前分支找到最后一次 todo 结果
→ 用那份快照整表替换内存
→ 前台会话才刷新面板

显示：
内存里的前台格子
→ 丢掉已删除、藏起上轮已完成
→ 画在编辑器上方；空表就卸掉面板
```

所以它不是：

- **不是项目管理软件。** 没有截止日期、没有跨会话项目、没有多人指派。
- **不是自己的数据库。** 包内不写任务文件，不启 sqlite，不听端口。
- **不是面板自己记住了列表。** 面板是视图。关掉面板，列表还在会话分支里。
- **不是无头会话的必需 UI。** 无头模式仍然有 `todo` 工具；只是什么都不画。

正面定义：**它是寄生在 Pi 会话进程里的扩展。** 模型用 `todo` 工具改一张表；这张表的权威副本是会话分支上最后一次工具结果；内存 store 是按会话 id 切开的缓存；编辑器上方的面板只渲染前台那一格。

权威数据源尽早点名：

- **权威内容**是当前分支上、`toolName === "todo"` 且 `details` 形如 `{ tasks, nextId }` 的**最后一条** toolResult。
- 内存 `Map<sid, TaskState>` 是派生缓存，进程一关就没了，下次靠回放重建。
- 面板读取的是「前台指针」指向的那一格，不是调用工具的那个 sid。

## 2. 为什么不自己写一份 todo.json

直觉方案是扩展自己往磁盘写列表。它没有这么做，因为 Pi 已经有一份更稳的日志：会话分支。

| 该存 / 该用 | 不该存 / 不该用 |
|---|---|
| 每次工具调用带上**整表快照**（last-write-wins） | 只存增量 diff，回放时还得自己做 replay log |
| 压缩、reload、切树时从分支重建 | 另写一份文件，和会话分叉对不齐 |
| 删除做成墓碑 `deleted` | 从数组里 splice 掉，旧快照无法解释「这个 id 曾经存在」 |
| 面板懒加载，没任务就不建 | 启动时先占一块 UI，空表也闪一下 |

所以职责是这样切的：

- **模型**决定建哪些任务、谁在进行、谁完成。扩展在 prompt 里建议「同一时刻只有一项 `in_progress`」，但不替模型做计划。
- **reducer** 只做纯计算：合法就出新状态，非法就原样返回并带错误。
- **Pi 宿主**负责把 `details` 写进分支。本包不碰那份持久化。
- **面板**负责让人看见前台会话的表。看不见 ≠ 表不存在。

工具名 `todo` 是回放过滤器，也是权限表里的名字。**不要改名。** 改了，旧会话回放会变成空表。

## 3. 先看整体架构：三份「表」，只有一份是真的

文档视角：

```text
┌────────────────────────────────────────────┐
│ 会话分支（权威）                              │
│ 每次 todo 工具结果带 { tasks, nextId }        │
└──────────────────┬─────────────────────────┘
                   │ session_start / compact / tree 时 replay
┌──────────────────▼─────────────────────────┐
│ 内存 store（按 sid 分区的缓存）               │
│ 热路径：工具 execute 直接 commit              │
└──────────────────┬─────────────────────────┘
                   │ 仅前台 sid
┌──────────────────▼─────────────────────────┐
│ 面板 TodoOverlay（视图）                      │
│ getRenderState() → 格式化 → aboveEditor      │
└────────────────────────────────────────────┘
```

和进程真相并置时，差异是精华：

| 文档说法 | 进程真相 |
|---|---|
| 「启动时创建面板」 | 第一个带 UI 的 `session_start` 只**认领前台指针**。没可见任务时，连 overlay 模块都不 import。2 秒后的 prewarm 只预热模块，仍不建 widget。 |
| 「列表是持久的」 | 持久的是 Pi 的会话文件。本包的 Map 在 `session_shutdown` 时逐 sid 清掉。 |
| 「`/todos` 就是面板」 | `/todos` 读**调用者**的 sid，用 notify 打一份文本。面板读**前台**格子。两条路。 |

类名只在它恰好是分层边界时出现：

- `applyTaskMutation` — 纯函数，唯一合法的状态计算。
- `commitState` / `replaceState` / `evictSession` — 内存 Map 仅有的三处写入。
- `replayFromBranch` — 纯函数，自己不碰 store。
- `TodoOverlay` — 视图，渲染时读 `getRenderState()`，**禁止**在 `tool_execution_end` 里回放分支（那时候分支还是旧的，`message_end` 还没跑）。

## 4. 实际怎样运行：工具一直在，面板看情况

判定句：rpiv-todo **是 Pi 扩展，不是服务，也不是独立 TUI 程序。**

```text
package.json
  "pi": { "extensions": ["./index.ts"] }

index.ts default export
  → 注册 todo 工具、/todos 命令、折叠快捷键
  → 听 session_start / compact / tree / shutdown
  → 听 tool_execution_end、agent_start
  → 2 秒后预热 overlay 模块（unref，不拖住嵌入方）
```

没有常驻进程。没有自己的 HTTP。没有定时把任务写盘的 cron。列表能活过 `/reload`，是因为 Pi 把 toolResult 留在了会话里，扩展再读回来。

交互式 vs 无头：

| | 交互式 | 无头 |
|---|---|---|
| `todo` 工具 | 有 | 有 |
| 内存格子 | 按 sid | 按 sid |
| 面板 | 有可见任务才建 | 永不构造 |
| `/todos` | 打一份分组文本 | 报需要交互模式 |
| 折叠快捷键 | 默认 `ctrl+shift+t` | 注册了也是 no-op |

和宿主的关系：

```text
Pi 会话进程
 ├─ 会话分支（宿主持久化）
 ├─ rpiv-todo 回调
 │    ├─ execute：同步改内存 + 返回 envelope
 │    ├─ 生命周期：回放、清格子
 │    └─ 懒加载的 TodoOverlay（可能尚未 import）
 └─ 可选 peer：@juicesharp/rpiv-i18n（没有就用内嵌英文）
```

配置在 `~/.config/rpiv-todo/config.json`（同样走 XDG + 只读遗留回退）。它管的是面板行数、折叠键、prompt 指导，**不管任务内容**。任务内容不在这份文件里。

哪些改动要 `/reload`：

| 字段 | 生效时机 |
|---|---|
| `maxWidgetLines`（默认 12，下限 3） | 每次渲染读，不用 reload |
| `collapseKey`（默认 `ctrl+shift+t`，`off` 关闭） | 绑定在工厂创建时读一次，要 `/reload` |
| `guidance.promptSnippet` / `promptGuidelines` | 注册工具时读一次，要 `/reload` |

折叠提示文案是每次渲染现拼的，可能和已经绑上的键暂时不一致。这是已知窗口，不是热更新。

## 5. 链路一：模型改一行任务

```text
工具入口 → 纯计算 → 提交内存 → 信封回模型 → 宿主落分支 → 异步刷新面板
```

### 5.1 工具入口：`todo.ts` 的 `execute`

动作是 `create | update | list | get | delete | clear`。身份键是调用者的 sid，不是前台指针。子会话改的是子会话自己的格子。

### 5.2 纯计算：`applyTaskMutation`

同步、无 I/O。不在这里做 ANSI 清洗——清洗只发生在给人看的字符串上，存进快照的 `subject` 保持原样。不要把「防终端注入」理解成「reducer 的输入校验」。

状态机：

| 从 | 可以到 |
|---|---|
| pending | in_progress、completed、deleted |
| in_progress | pending、completed、deleted |
| completed | 只能 deleted（不能回到进行中） |
| deleted | 终点 |

同状态更新是合法 no-op。`delete` 是墓碑，不是从数组抹掉。`clear` 回到 `{ tasks: [], nextId: 1 }`。

`blockedBy` 必须是 DAG：自依赖、环、指向不存在或已删除的任务，都在**写入前**拒绝，状态不变。

### 5.3 提交内存：`commitState(sid, newState)`

同步 `Map.set`。到这里，**当前进程里**这张表已经变了。还没有证明 Pi 已经把快照写进会话文件。

### 5.4 信封回模型

`buildToolResult` 产出 `{ content, details }`。`details` 带完整 `tasks` + `nextId`，字段名和顺序被回放兼容钉死。reducer 出错时状态不变，错误走 in-band：`op.kind === "error"`，`details.error` 有值。工具本身仍算执行完，不是抛给宿主的崩溃。

### 5.5 宿主落分支

本包不管这一步。Pi 把 toolResult 追加到当前分支。这才是下次 `/reload` 能看见列表的原因。

### 5.6 异步刷新面板

`tool_execution_end` 里：名字是 `todo` 且不是错误，才 `await updateTodoOverlay()`。这一步**异步**，可能第一次才去 `import("./todo-overlay.js")`。

**完成 ≠ 就绪：**

- `execute` 返回成功：内存已改、模型已拿到新快照。
- 不证明面板已经画上。模块还在加载、当前没有 UI、可见任务仍是空，都会让这一步提前 return。
- 不证明会话文件已经 flush。那是宿主的事。

瞬时 import 失败会打 warn、清 memo、下次再试。若模块命名空间坏了（`TodoOverlay` 根本不是函数），错误会闩住，文案是 `Todo overlay module cache is stale; restart Pi`，不会自己好。

## 6. 链路二：从会话分支整表替换

触发：`session_start`、`session_compact`、`session_tree`。

```text
取出 sid
  → replayFromBranch(ctx)     纯函数，last-write-wins
    → replaceState(id, 快照)  整表替换，不是 merge
      → 仅当 id 是前台指针，才刷新面板（并重置「已完成行的隐藏记录」）
```

回放规则：按时间走当前分支，最后一条合格的 `todo` toolResult 赢。没有合格条目就得到空表。形状不对的旧记录直接跳过，不炸。

`session_start` 额外做三件事：

1. 没有 UI 直接 return（无头不认领面板）。
2. 前台指针还空着，就由这个 sid 认领。
3. `lifecycleGeneration++`，并记下 `uiCtx`。正在飞的懒加载如果代数对不上，结果丢掉。

会话被替换时，ctx 会变成 stale。回放路径吞掉 `/stale after session replacement/`，**保留当前内存**，等下一次真正的 `session_start` 再回放。不要把「这一次回放抛了」理解成「表已经空了」。

前台 `session_shutdown`：丢掉 overlay、清前台指针、驱逐格子。子会话 shutdown **不许**拆前台面板——它只驱逐自己那一格。

## 7. 链路三：面板怎么决定画什么

```text
getRenderState()          前台格子
  → 复制 tasks
    → 丢掉 deleted，藏起「上轮已经展示过的 completed」
      → 空 → setWidget(undefined) 自动卸面板
        → 否则按行预算排版，放到 aboveEditor
```

折叠：默认快捷键把面板收成两行（标题 + 展开提示）。空面板时快捷键是 no-op，因为 widget 根本没注册。

溢出（`maxWidgetLines`，标题也占一行）：先丢 completed，再截未完成的尾巴，最后一行变成 `+N more`。Pi 自己的 `ctrl+o` 展开工具输出时，面板会显示全部。

`agent_start` 时，上一轮已经在屏幕上待过的 completed 被放进隐藏集合。所以「刚勾完的还在，下一轮开始才让路」。reload / compact 会重置这套隐藏，整表重新出现。这是显示策略，不是数据丢了。

i18n 只包 UI 铬：标题、状态名、`/todos` 的分组头。给模型看的 envelope、reducer 错误、schema 描述**保持英文**。没装 `@juicesharp/rpiv-i18n` 时，`t(key, fallback)` 原样返回 fallback。扩展不会因为缺 i18n 而挂掉。

## 8. 会话隔离：子会话可以有自己的表，但不能抢面板

store 按 sid 分区，就是为了这个。子会话（不同 sid）读写自己的格子，回放自己的分支。

| 事件 | 子会话允许做什么 | 不允许做什么 |
|---|---|---|
| `session_start` | 回放自己的分支进自己的格子 | 把前台指针抢过来、重绑面板 |
| 调用 `todo` | 改自己的格子 | 改父会话的格子 |
| `tool_execution_end` | 若它不是前台，面板不跟着刷 | 让用户看见子会话的表盖住父会话 |
| `session_shutdown` | 驱逐自己的格子 | `dispose` 前台 overlay |

已知限制：工具的 `renderCall` 没有 ctx，只能画前台格子。子会话的 transcript 里任务标题会退化成 `#<id>`，以免误用兄弟会话里「碰巧同 id」的标题。ids 每个会话从 1 重数。

## 9. 概念区分、误区和排错

| 词 | 钉死的意思 |
|---|---|
| 分支快照 | 权威、可回放、last-write-wins |
| 内存 store | 热路径缓存，按 sid |
| 前台指针 | 决定面板和 `renderCall` 看哪一格，不写任务 |
| 面板 | 视图；空表卸载 |
| `/todos` | 调用者 sid 的文本转储，不是面板 |

常见误区：

- 「面板没了，任务就没了。」错。正：空表会卸 widget；权威在分支上。`/reload` 能回来。
- 「在 `tool_execution_end` 里 `replayFromBranch` 更稳。」错。正：那时分支还没加上刚结束的这条结果，回放会吃到旧快照。
- 「sanitize 发生在写入前。」错。正：它是渲染期的。快照里的 subject 可以仍含控制字符。
- 「无头没有 todo。」错。正：工具和内存都在，缺的是 UI。
- 「改完 `collapseKey` 立刻能用。」错。正：绑定发生在扩展工厂创建时。

症状式排错：

| 症状 | 分层检查 | 不要先怀疑 |
|---|---|---|
| `/reload` 后列表空了 | 分支上有没有 `toolName === "todo"` 且带 `tasks`/`nextId` 的 toolResult；工具名是否被改过 | reducer 算错（空表更常见是回放过滤没中） |
| 面板不出现，但模型说任务在 | 是不是无头；有没有非 deleted 任务；overlay import 有没有 warn | store 没 commit（execute 成功则已经 commit） |
| 子 agent 一跑，面板变成另一张表 | 不该发生；查 sid 是否意外相同 | 「面板是全局单例所以必然串台」——格子不是单例，指针才是 |
| `Todo overlay module cache is stale; restart Pi` | jiti/模块命名空间坏了，闩住了 | 再调一次工具就能好（不能，要重启） |
| 折叠键没反应 | 面板是否已注册（空表未注册）；键是不是 `off`；改键后有没有 `/reload` | 状态机把任务删了 |

当前可靠性边界：没有包住「commit 内存 + 宿主落分支 + 刷新面板」的总事务。内存可以新、面板可以旧、分支可以还没写上。回放以分支为准，热路径以内存为准。这是当前可靠性边界。

## 10. 如果只记一条主线

可独立验证的稳定事实：

1. 权威源是会话分支上最后一次合格的 `todo` 快照，不是面板，也不是本包的配置文件。
2. 内存 store 按 sid 切开；面板只看前台那一格。
3. 写入链在 `execute` 里同步完成计算和 commit；面板刷新是之后的异步视图。
4. 无头模式工具仍可用。空表会卸面板，不等于清数据。
5. 工具名 `todo` 和 widget key `rpiv-todos` 是回放契约，不是可以顺便改的展示字符串。

如果只记一条完整主线，可以记成：

```text
模型调 todo
  → reducer 出新快照
    → 写入 sid 对应的内存格子
      → details 交给 Pi 写入分支
        → 前台才异步重绘面板

/reload
  → 从分支取出最后一份快照
    → 整表替换内存
      → 前台重绘
```

## 11. 想改代码时按这个顺序读

1. `package.json` + `index.ts` 文件头和 default export  
   看了能懂：运行形态、懒加载、前台认领、stale ctx、模块缓存闩。
2. `tool/types.ts`  
   看了能懂：为什么工具名不能改，`TaskDetails` 为什么是回放格式。
3. `todo.ts` 的 `execute`（大约 78–82 行附近）  
   看了能懂：热路径只有 reducer → commit → envelope 三步。
4. `state/store.ts` + `state/replay.ts`  
   看了能懂：缓存和权威源怎么分；前台指针为什么不是第四个写者。
5. `todo-overlay.ts` 前 80 行  
   看了能懂：自动卸载、`getRenderState()`、为什么这里不许 replay。
6. `state/invariants.ts` + `state/task-graph.ts`  
   看了能懂：四态和 DAG 拒绝规则。
7. `todo.session-isolation.test.ts`  
   看了能懂：子会话允许和禁止的完整合同。比再读一遍注释更准。

包内用法文档：`docs/overlay.md`、`docs/tool-schema.md`、`docs/configuration.md`。它们回答「用户看见什么」；和源码冲突时，以生命周期代码为准——尤其是「面板何时真正 new 出来」这一条。
