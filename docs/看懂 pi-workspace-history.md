# 看懂 pi-workspace-history：聊天树能走，工作区也能跟着回

> 本文面向第一次接触 `pi-workspace-history`、但已经知道「Pi 的 `/tree` 能在对话历史上跳」的读者。重点不是 Git 命令清单，而是讲清：它解决什么问题、影子仓库和用户自己的 `.git` 是什么关系、一次 `/undo` 怎样既改聊天又改文件、失败时会不会把工作区留在半恢复状态。
>
> **本文定位：小项目、二次开发深度。** 实现几乎集中在一个文件里，但运行形态和可靠性模型并不小。稳定认知放在「会话条目映射聊天节点、影子 git 保存文件快照」以及 dirty-guard / 失败回滚上；保留数量、扫描上限、超时属于易变细节。
>
> 源码基线：本仓库 `pi-workspace-history`，包版本 `0.3.0`，peer `@earendil-works/pi-coding-agent` `^0.84.4`，Node `>=22.19.0`；工作区 HEAD `6f1c21c`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游：[wcldyx/pi-workspace-history](https://github.com/wcldyx/pi-workspace-history)。

## 1. TLDR：它做的事情可以压缩成两条链路

Pi 自己能在聊天树上跳。这个扩展要补的是：**跳到哪个节点，工作区也可以回到那个节点对应的文件状态**——同时允许你选择「只回对话、文件不动」。

```text
写入链路（每个 Agent 回合）
  session_start 准备影子仓库
  → 用户提交前拍 before 快照
  → Agent 改文件
  → turn_end / agent_settled 拍 after 快照
  → 会话条目记下「这个聊天节点 = 这个 commit」

导航链路（/undo、/redo、/tree）
  可选：检查工作区是否相对当前快照干净
  → 先拍 rollback 安全网
  → 把影子 commit 恢复进真实工作区
  → 再让 Pi 把聊天树跳过去
  → 失败则恢复 rollback；再失败则留下 recovery 文件
```

所以它不是：

- **不是** 给聊天记录做 Ctrl+Z。Pi 已经能在树上走；缺的是文件。
- **不是** 操作你项目的 `.git` 历史。影子仓库是另一份 bare repo，默认活在 `~/.pi/agent/state/workspace-history/`。
- **不是** 时间机器备份整个磁盘。有 ignore、扫描上限，home 目录默认直接禁用。
- **不是** 自动迁移旧的工作区内 `.pi/workspace-history/`。旧状态不会被读过来。

正面定义：它是挂在 Pi 会话生命周期上的 **工作区时间机器**，用影子 git 给每个聊天节点钉一份可恢复的文件树。

权威数据源尽早分开：

- **文件内容的权威**：影子仓库里的 commit（`repo.git`）。
- **「哪个聊天节点对应哪次快照」的权威**：Pi 会话里的自定义条目 `workspace-history.snapshot`，外加 `turnSnapshots` 文件。
- 用户项目的 `.git` **不是** 这套历史的权威，也不该被这个插件当存储用。

## 2. 为什么聊天 undo 不够

Agent 一旦 `edit` / `write` / `bash`，磁盘已经变了。你把对话指针拨回三条之前，模型以为自己还没改，文件却还是改完的样子——这比没有 undo 更危险。

正反例：

| 该让插件恢复文件 | 不该恢复文件 |
|---|---|
| 想撤销刚刚那一轮 Agent 乱改 | 只想重看旧回复，手头的手动修改要留 |
| `/tree` 跳到另一条历史分支，希望代码也跟着 | 工作区相对当前快照是 dirty 的，你还没决定怎么处理 |
| 手动改完想钉住，用 `/checkpoint` | 当前目录是 `$HOME`，扫描会把半个用户盘吃进去 |

职责分工：

- **Pi 宿主**管聊天树、`navigateTree`、会话条目存储。
- **本扩展**管影子 git、before/after 映射、dirty-guard、恢复失败的 rollback。
- **用户**在每次导航时选择模式：`Conversation and workspace` 还是 `Conversation only (keep current files)`。
- **用户自己的 git** 继续过用户的版本生活；插件不往里面写 plugin commit。

不要把「支持 `/undo`」理解成「替换了 git checkout」。undo 先问你恢复不恢复文件；选 conversation only 时，影子仓库只当没被用到。

## 3. 先看整体架构，不急着看类名

文档视角：

```text
宿主事件层   session_start / input / before_agent_start / turn_end /
            agent_end / agent_settled / session_before_tree / session_tree
     ↓
可用性层     auto 模式：home、磁盘根、没项目标记 → 禁用
     ↓
快照层       扫描工作区（ignore + 上限）→ 写入影子 git commit
     ↓
映射层       会话自定义条目 + turnSnapshots：聊天节点 ↔ commit
     ↓
导航层       dirty-guard → rollback 快照 → restore → 再跳聊天树
     ↓
恢复层       restore 失败回到 rollback；rollback 失败留下 recovery.json
```

快照有四种 `kind`：`baseline`（会话开始的底）、`before`（这回合 Agent 动手前）、`after`（动手后）、`manual`（`/checkpoint`）。

进程真相：扩展代码跑在 **Pi 宿主进程**里；真正干活的外部进程是一次次 `git`（对着 `--git-dir` 指向的影子仓库）。没有 history daemon，没有后台 watcher。

```text
Pi 宿主进程
  ├─ 扩展（单文件 .pi/extensions/workspace-history.ts）
  ├─ 多次 spawn git（影子仓库）
  └─ 真实工作区文件（restore 的目标）

磁盘
  ├─ 用户项目/（被快照、被恢复）
  ├─ 用户项目/.git/（ co-exist，不当存储）
  └─ ~/.pi/agent/state/workspace-history/workspaces/<hash>/sessions/<id>/repo.git
```

图纸与进程的差异：看起来像「一个 git 插件」，其实 git 只是快照格式。会话条目才把这些 commit 钉到聊天树上。没有会话条目，影子仓库里的 commit 只是一堆没人认领的树。

存储布局（默认在工作区外）：

```text
~/.pi/agent/state/workspace-history/
  workspaces/<workspaceHash>/
    meta.json
    sessions/<sessionId>/
      repo.git/          影子 bare repo
      redo.json          redo 栈
      meta.json
  logs/timemachine.log
```

无效的 `repo.git` 会被改名为 `repo.git.invalid-<timestamp>-<uuid>` 再重建。清理是 LRU：默认大约 10 个工作区、每工作区 3 个会话；元数据损坏的目录**故意不删**。

## 4. 实际怎样运行：寄生扩展 + 按需 git，不是常驻时间机器

证据：

- `package.json` 的 `pi.extensions` 指向 `.pi/extensions/workspace-history.ts`。
- 没有 `bin`，没有编译产物；Pi 直接吃这份 TypeScript。
- 依赖只有 `ignore`；git 必须在 PATH 上。

`enabled` 默认是 `"auto"`：

- 当前目录是用户 home → 禁用（可用 `allowHomeDirectory` 打开）。
- 文件系统根 → 禁用。
- 向上找不到项目标记（`.git` / `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` 等）→ 禁用。
- 显式 `enabled: true` 才在这些地方强行开。

所以「装了插件」≠「每次打开 Pi 都在拍快照」。在家目录里开 Pi，插件会安静关掉，避免启动扫描卡死。

有没有常驻进程：**没有。** `session_start` 之后会 **延迟** 做一次 baseline warmup（给第一次回合省时间），那是进程内 timer，不是 OS daemon。Pi 退了 timer 一起没。

和宿主的关系：扩展大量 `pi.on(...)`。聊天导航的关键缝是 `session_before_tree`（这时工作区还没跳，扩展先 restore）和 `session_tree`（聊天已经跳完，扩展补映射）。**被谁拉起的导航，工作区恢复就发生在跳树之前**——否则会出现「对话已经是旧的、文件还是新的」的中间态。

命令：

| 命令 | 人话 |
|---|---|
| `/undo` | 回到上一回合的 before；可选恢复文件；当前叶子进 redo 栈 |
| `/redo` | 反向走 redo 栈 |
| `/checkpoint [label]` | 拍一张 `manual` 快照，不移动聊天树 |
| `/tree` | Pi 原生命令；本扩展在 before_tree 里插入恢复 |

`/undo` 不是自己实现一套聊天跳转：它选目标节点，再调 `ctx.navigateTree`。文件恢复挂在同一条 before_tree 钩子上，所以 `/undo` 和手动 `/tree` 走同一条恢复代码。这是刻意的。

## 5. 纵向链路一：一回合怎样变成 before / after

```text
可用性检查 → （可选）baseline 预热 → before 快照 → Agent 干活 → after 快照 → 写入映射
```

### 5.1 可用性层：收到 session_start → 判断能不能干活 → 产出 enabled 或一句禁用原因

载体：Pi 进程。禁用时后续钩子全部 skip。不要把「没看到快照」先怪 git：先看是不是 auto 关掉了。

### 5.2 预热层：session_start 后短延迟 → 尝试拍 baseline → 产出一个底 commit

异步、可取消。如果用户已经开始输入下一回合，warmup 会放弃，避免和 before 快照打架。**warmup 完成 ≠ 已经有 before。** 它只是尽量让第一次 `createSnapshotCommit` 少做一次全量扫描。

### 5.3 before 层：用户提交非斜杠命令 → 拍「动手前」的树 → 产出 before commit

载体：`input` / `before_agent_start`，Pi 进程内同步等待快照（git 是子进程）。斜杠命令不拍 before——`/undo` 自己不是一次 Agent 回合。

before 会清 redo 栈：你一旦从当前叶子继续往前走，redo 就失效。这和编辑器 undo 一样。

扫描有天花板：默认 20_000 文件、3_000 目录、5 秒。超了就失败或降级，而不是默默漏文件还宣称完整。ignore 来自默认列表 + 用户 gitignore 一类规则；硬排除路径即使被 gitignore 反向包含也不会重新纳管。

### 5.4 工作层：Agent 改文件

插件在这一段**故意不盯**每一笔 write。它只在回合边界拍树。Agent 中途崩溃、用户 Ctrl+C，after 可能还没有——下次导航会走 dirty-guard。

### 5.5 after 层：turn_end / agent_end / agent_settled → 再拍一棵树 → 产出 after commit + 会话条目

同一回合可能有多次 settled；扩展会把 after 记在「用户消息 ↔ 助手消息」这对节点上。映射写进：

- 会话自定义条目（跟着 Pi 的 session 文件走）
- `turnSnapshots` 文件（给 undo 找目标用）

**after 条目写上 ≠ 你能在用户的 `git log` 里看到它。** 去影子仓库的 ref 上看。

git 超时默认 60 秒。影子仓库的 `index.lock` 会等、会认 stale。这些是为了不把工作区永久卡在半次 commit。

## 6. 纵向链路二：`/undo` 或 `/tree` 怎样把文件拨回去

```text
选导航模式 → dirty-guard → 拍 rollback → restore 目标 commit → 跳聊天树 → 失败则回滚
```

### 6.1 模式层：收到 undo/tree → 问用户恢复不恢复文件 → 产出 navigationMode

两种：`conversationAndWorkspace` / `conversationOnly`。只回对话时，**不跑** dirty-guard，也不 restore。聊天走了，磁盘不动。这是功能，不是 bug。

### 6.2 守卫层：相对「当前叶子对应的快照」比工作区 → 脏则拦住

`ensureNoUnsnapshottedChanges`。脏的含义是：有文件变了，但还没有一张快照认领它们。插件拒绝拿这些改动去赌一次 restore。用户该做的是 `/checkpoint` 或先处理脏文件。

缺快照（`missing`）和脏（`dirty`）不是同一回事。缺快照会警告并尽量从当前状态继续，而不是假装能精确回到过去。

### 6.3 安全网层：restore 之前先把当前工作区再 commit 一次，当作 rollback

`restoreSnapshotCommitSafely`：先 `createSnapshotCommit(rollback …)`，再恢复目标。目标失败 → 把 rollback 再 restore 回去。rollback 也失败 → 写下 `recovery` 状态，后续操作会先尝试恢复；若这时工作区又被人改了，会要求 `/checkpoint` 保住那些改动。

这是当前可靠性模型的天花板：**没有**把「恢复 3000 个文件」包在文件系统事务里。安全网是「再拍一张、失败就回到这张」，外加 Windows 上对占用文件的有限次重试。

### 6.4 恢复层：git 把影子 commit 铺回真实工作区

载体：git 子进程，工作树是用户项目，`--git-dir` 是影子仓库。用户 `.git` 不被当作源。被 ignore / 保护的路径不会被覆盖。

restore 失败会 **取消这次树导航**（`Tree navigation cancelled`），避免聊天和工作区各走各的。

### 6.5 跳树层：工作区已经到位 → `navigateTree` / `session_tree` → 聊天指针移动

`/undo` 成功后把旧叶子推进 redo 栈，并记住当时的 navigationMode——redo 回来时按同一模式处理文件。

**聊天跳成功 ≠ 文件一定恢复了。** 你可能选了 conversation only。反过来，文件恢复失败时聊天跳会被取消，这是有意绑死。

可靠性表：

| 失败位置 | 聊天树 | 工作区 | 下次 |
|---|---|---|---|
| dirty-guard | 不动 | 不动 | checkpoint 或处理脏文件 |
| restore 失败，rollback 成功 | 取消跳转 | 回到 restore 前 | 关掉占用文件再试 |
| restore 失败，rollback 失败 | 取消跳转 | 可能半恢复；有 recovery 文件 | 先让插件 recover；若又被改了就 checkpoint |
| conversation only | 跳了 | 不动 | 预期行为 |
| 影子仓库损坏 | 视可用性 | 隔离旧 repo.git 再重建 | 精确历史可能丢，当前状态可重新当 baseline |

## 7. 边界、误区

| 词 | 是 | 不是 |
|---|---|---|
| 影子仓库 | 插件私有的 bare git | 你的项目历史 |
| before / after | 一回合两端的工作区树 | git rebase 的那套 |
| dirty | 相对当前快照有未认领改动 | `git status` 相对用户分支脏 |
| conversation only | 只动聊天指针 | 插件坏了所以没恢复 |
| `/checkpoint` | 钉住当前磁盘，不跳树 | 替代用户 git commit |
| auto 禁用 | 保护 home / 无项目目录 | 安装失败 |

常见误区：

- **错。** 以为 `/undo` 等于 `git checkout HEAD~1`。**正。** 它跳的是 Pi 聊天树 + 可选影子快照；用户分支指针不动。
- **错。** 以为手动改的文件总会被下一回合的 after 保护好。**正。** 回合开始前没 checkpoint、导航时又选了恢复文件，脏改动会被拦住或（在你强行处理之后）被覆盖。守卫的存在就是为了不默默盖掉。
- **错。** 以为装上就在任意目录拍快照。**正。** auto 模式在 home 直接关。
- **错。** 以为旧的 `.pi/workspace-history/` 会自动搬到 `~/.pi/agent/state/`。**正。** 不迁移。
- **错。** 以为 restore 失败聊天也会假装成功。**正。** 导航会被取消。

## 8. 失败时先查哪条链路

**`/undo` 提示 Nothing to undo。** 还没有 after 快照。可能回合没结束，或插件在这个目录是禁用的。不要先 `rm -rf` 影子仓库。

**提示 Workspace history is disabled … home folder。** auto 保护。进项目目录再开，或显式开启。

**导航被拦，说工作区变了。** dirty-guard。先 `/checkpoint` 或把文件处理干净。不要先怀疑影子 git 坏了。

**Workspace restore failed. Tree navigation cancelled。** 恢复层失败，聊天没跳。Windows 上先关占用该文件的程序。看 `timemachine.log`。

**提示 incomplete restore / 要求 checkpoint。** rollback 也没能干净回去。此时最危险的是继续跳树。按它说的 checkpoint，再决定。

**第一次回合特别慢。** baseline 扫描大仓库。查扫描上限、ignore 是否漏了 `node_modules`。`tests/benchmark-first-turn.ts` 就是为这个开销准备的。

**影子仓库反复 quarantine。** `repo.git` 不合法。插件会改名隔离再 init。精确到旧节点的恢复可能没了，但当前工作区还能重新拍。

## 9. 如果只记一条主线

稳定事实：

1. 形态是 **Pi 扩展 + 按需 git 子进程**，无常驻 daemon。
2. **影子 git 存文件，会话条目存映射**；用户 `.git` 不是权威。
3. 导航可以只动聊天、不动文件；要动文件就先 dirty-guard。
4. restore 的安全网是 rollback 快照 + recovery 文件，不是文件系统事务。
5. auto 模式在 home / 无项目标记处禁用，这是功能。

```text
回合前拍 before → Agent 改盘 → 回合后拍 after
     ↓
/undo 或 /tree
     ↓
（可选）恢复影子 commit 到真实工作区
     ↓
再移动聊天指针
     ↓
失败则回到 rollback，聊天也不跳
```

## 10. 想改代码时按这个顺序读

实现几乎都在 `.pi/extensions/workspace-history.ts`。不要按函数名散读，按生命周期读：

1. 文件顶部常量和 `SnapshotKind` / `NavigationMode`：四种快照、两种导航。
2. `evaluateWorkspaceHistoryAvailability`：auto 禁用规则。
3. `getWorkspaceStoragePaths`：磁盘布局、hash、session 隔离。
4. `ensureShadowRepo` / `quarantineInvalidShadowGitDir`：坏仓库怎么隔离。
5. `createSnapshotCommit`：扫描 + 写入影子 commit。看了能懂「拍一张」到底写了什么。
6. `restoreSnapshotCommitSafely`：rollback → restore → recovery。可靠性边界在这里。
7. `ensureNoUnsnapshottedChanges`：dirty-guard 文案和返回值。
8. `pi.on("session_start" | "input" | "before_agent_start" | "turn_end" | "agent_settled")`：写入链路。
9. `pi.on("session_before_tree" | "session_tree")`：导航链路为什么恢复发生在跳树前。
10. `registerCommand("undo"|"redo"|"checkpoint")`：用户命令只是导航的壳。
11. `tests/workspace-history.test.ts`：行为合同；改 restore 必须覆盖影子仓库和工作区两边。

本地冒烟：在一个带 `package.json` 的目录 `pi install` 本包，让 Agent 改一个文件，`/undo` 选「Conversation and workspace」，看文件是否回去；再 `/undo` 选 conversation only，确认文件不动、对话在动。

## 参考资料

- [pi-workspace-history README](https://github.com/wcldyx/pi-workspace-history)
- [中文 README](https://github.com/wcldyx/pi-workspace-history/blob/main/README.zh-CN.md)
- 仓库内 `pi_workspace_timemachine_requirements_technical_design.md`（设计原文，细节以源码为准）
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
