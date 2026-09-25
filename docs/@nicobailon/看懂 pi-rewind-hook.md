# 看懂 pi-rewind-hook：会话账本记点，git 对象存文件，不动 HEAD

> 本文面向第一次接触 `pi-rewind-hook`、但已经知道「Pi 会话可以 fork / 沿 `/tree` 跳转、工作区往往是一个 git 仓库」的读者。重点不是罗列 hook 名，而是讲清：检查点写在哪、恢复会不会把你的分支指针拽走、retention 删的是什么。
>
> **本文定位：小项目、二次开发深度。** 稳定认知放在「账本 vs 对象库 vs 工作区」三份权威上；保留天数、状态栏文案、安装目录属于易变细节。
>
> 源码基线：本仓库 `@nicobailon/pi-rewind-hook`，包版本 `1.8.6`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13ed69a55f94889194018f652adf628ddc4b`（2026-09-03）。上游独立仓库：[nicobailon/pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook)。需要 Pi v0.74.0+，并且当前工作区是 git 仓库。

## 1. TLDR：它做的事情可以压缩成「先拍照，再按消息把照片贴回去」

Pi 允许你从某条消息 fork 出另一条会话，或在 session tree 里跳到旧节点。默认只动 **对话**。这个扩展额外记住当时工作区文件长什么样，让你可以选择连文件一起回到那个点。

```text
每次该拍照时
  → 用临时 index 把工作区打成一棵 git tree
  → commit-tree 做成快照 commit（不 checkout）
  → 把 commit sha 写进当前 session 的隐藏条目
  → 再用 refs/pi-rewind/store 吊住这些对象，避免被 gc 掉

你在 /fork 或 /tree 选节点
  → 扩展从账本（可沿 parentSession 追溯）解析出目标 sha
  → 先把「现在」再拍一张当 undo
  → git restore --worktree 把文件改回去
  → HEAD 仍然停在你原来的分支上
```

所以它不是：

- 不是 `git checkout` 到某个历史提交。用户分支的 HEAD 不被这个扩展移动。
- 不是每个检查点一个 git 分支 / 一个 ref。全仓库共用一根 `refs/pi-rewind/store`。
- 不是时间机器：`.gitignore` 的文件、空目录、子模块里未提交的脏文件，都不在「精确恢复」模型里。
- 不是独立数据库。没有 SQLite，没有 `~/.pi/rewind.db`。账本就是 session jsonl 里的自定义条目。

正面定义：它是 **会话内的文件检查点账本**，对象存在当前仓库的 git 对象库里，恢复只改工作区文件。

## 2. 为什么检查点必须写进 session，而不是只打 git tag

正例：你在消息 #12 让 Agent 改了一堆文件，后来 fork 回 #8 想重说需求。对话可以分叉，但磁盘上的文件还停在 #12 之后。没有「#8 当时的树」，fork 出来的新会话会带着错误的工作区继续改。

反例：给每个检查点打 `rewind/12` 这种 ref。fork、resume、compaction 之后，新 session 文件和旧 ref 对不上号；gc 策略也很难回答「哪些 ref 还被哪次会话引用」。

所以拆成两份数据：

| 东西 | 写在哪 | 回答什么问题 |
|---|---|---|
| 账本 | session jsonl 的隐藏自定义条目 | 「哪条消息对应哪次快照」 |
| 对象 | git commit / tree（普通对象库） | 「那次快照的文件内容」 |
| 吊绳 | 唯一的 `refs/pi-rewind/store` | 「这些对象先别 gc」 |

权威在账本。ref 只是可达性。删掉 ref、账本还在，快照对象可能被 gc 变成「账本指着一个不存在的 sha」；只跑 gc 而不改 jsonl，对话时间线不会缩短。

## 3. 先看整体架构，不急着看函数名

文档视角：

```text
触发层   before_agent_start / turn_end / compact / fork / tree / shutdown
   ↓
拍照层   临时 GIT_INDEX_FILE + git add -A + write-tree + commit-tree
   ↓
账本层   rewind-turn / rewind-op / rewind-fork-pending（写进当前 session）
   ↓
解析层   本会话条目 + parentSession 祖先；可选扫同仓库其它 session
   ↓
恢复层   再拍一张 undo → restore --worktree →（可选）子模块 detach checkout
   ↓
吊绳层   empty-tree keepalive commit 把快照挂到 refs/pi-rewind/store
```

进程真相：这六层全在 **当前 Pi 宿主进程**里，外加它调用的 `git` 子进程。没有 rewind 服务器，没有后台 daemon。retention 扫描也是同进程、同一次会话里抽空做。

| 节点 | 载体 | 同步？ |
|---|---|---|
| 拍照 | `git` 子进程 + 临时 index 文件 | 同步；失败就这次没有新绑定 |
| 写账本 | `pi.appendEntry(...)` 进当前 session | 同步追加；compaction 不会把这些当普通聊天压缩掉（它们是自定义条目） |
| 用户选择恢复项 | TUI `ctx.ui.select` | 同步；取消则 `{ cancel: true }` 拦住 fork/tree |
| 无 UI（脚本/CI） | 没有 select | 只保证拍一张「现在」，不恢复旧文件 |
| retention | 同进程扫描 session 文件 + `update-ref` | 异步抽空；有启动时间预算 |

完成 ≠ 就绪：

- `appendEntry` 成功 ≠ 对象一定还在。没有 store ref、又被 `git gc` 掉，sha 会变成死指针。
- 选了 “Restore all” 且 `git restore` 返回了 ≠ 对话已经跳到目标节点。文件恢复发生在 `session_before_fork` / `session_before_tree`；会话跳转是宿主接下来才做的事。
- retention 扫完 ≠ jsonl 变短。它只改可达性。

## 4. 实际怎样运行：扩展，不是 hook 守护进程

名字还叫 `pi-rewind-hook`，是历史包袱。现在的安装形态是 **普通 Pi 扩展**：`pi install npm:pi-rewind-hook`，文件落到 `~/.pi/agent/extensions/rewind/`，靠目录自动发现，不必在 `settings.json` 里再写一遍路径。

仓库里的 `install.js` 是另一条老安装器：从 GitHub raw 拉 `index.ts`，并清理 `~/.pi/agent/hooks/rewind` 这种更老的 hooks 布局。二次开发以 `package.json` 的 `pi.extensions` 为准，不要把 `install.js` 当成运行时。

不是 git 仓库时，扩展几乎是空转：hook 仍在，但拍照 / 恢复直接 return。这是硬前置，不是配置开关。检测用的是当前工作区能不能当 git 根，不是「用户有没有安装 git」——git 二进制在、cwd 却不是仓库，同样不拍照。

子模块工作区若脏，扩展选择拒绝而不是「尽量恢复」：精确模型一旦在这里放水，账本上的 sha 会撒谎。嵌套 submodule 同样拒绝，因为快照只记录一层 gitlink。

设置读 `~/.pi/agent/settings.json` 的 `rewind` 键。文件坏了 **不能把 rewind 整套关掉**——源码明确 fallback 到默认：继续拍照、默认不 retention。这和 pi-intercom「坏配置失败关闭」相反，不要套用。

有 UI 时，扩展往 Pi 状态栏写一个 `rewind` 键：当前是否已绑定、最近一次快照短 sha。这是派生视图，不是权威。无 UI 的会话不写这块，避免在脚本里弹通知。通知本身（`Rewind: ...`）失败也只是提示，不会回滚已经写下的账本条目——所以排错时「没看到 toast」不等于「没拍照」。

## 5. 账本长什么样（仍然不讲类）

三种隐藏条目，都是 `customType`：

- `rewind-turn`：一轮对话里打了哪些快照、哪些消息 id 绑到哪个快照下标。这是主账本。
- `rewind-op`：一次显式操作（fork 恢复、tree 恢复、compact 绑点、undo）。
- `rewind-fork-pending`：fork 当时选定的当前 sha / undo sha，给新会话开工时接着用。

版本字段 `v: 2`（`RETENTION_VERSION`）。读到不认识的形状就跳过，retention 扫描也是 best-effort：坏行不当整文件失败。

绑定对象是「可恢复的树节点」：用户消息、助手消息、自定义消息、compaction、summary。不是每一条 tool 调用都单独占一个检查点。同一 `entryId` 已经绑过就不再拍，避免一轮里刷爆对象库。

跨会话：新 fork 的 header 带 `parentSession`。解析目标消息时，本会话没有绑定就沿祖先 jsonl 往上找。retention 的 `scanMode` 默认 `ancestor-only`；改成 `repo-sessions` 才会尽力扫发现到的其它 Pi session 文件。这是「尽力」，不是完整索引。

`session_start` 会 `reconstructState`：把当前 jsonl 里所有 `rewind-*` 条目重放成内存里的 `entryId → commitSha` 表，以及「当前 / undo」指针。新进程没有这份表，不重放就不知道 `/fork` 该恢复哪棵树。扫描磁盘上的祖先文件时，先用字符串 `"rewind-"` 做快路径——文件里根本没有 rewind 条目就只读 header，避免大 jsonl 逐行 JSON.parse。mtime 相同的文件进解析缓存。

用户在 Pi 里给某条消息打的 **label** 会进 `labeledEntryIds`。retention 若打开 `pinLabeledEntries`，这些绑定对应的快照不会因 `maxSnapshots` / `maxAgeDays` 被踢出 keepalive 链。label 是宿主的消息标签，不是 rewind 自己的书签 UI。

## 6. 纵向链路一：一次拍照

```text
1. 判定     当前 cwd 是 git 仓库？这条 entry 属于可恢复节点？还没绑过？
2. 隔离 index  mkdtemp + GIT_INDEX_FILE，避免弄脏用户自己的 index
3. 收工作区   git add -A（仍受 ignore 规则约束）
4. 写 tree    git write-tree → tree sha
5. 子模块体检  gitlink 可以拍；未 init / 脏子模块直接拒绝，不当成「差不多精确」
6. 写 commit  git commit-tree <tree> -m "pi rewind snapshot"
7. 吊住       再建一个 empty-tree 的 keepalive commit，parent 同时指向
              旧的 store head 和这张快照，然后 CAS 式 update-ref
8. 记账       放进当前 turn 的 collector，turn_end 时 append rewind-turn
```

第 6 步 **不** `git checkout`，**不** 移动 `HEAD`，**不** 改你正在开发的分支。快照 commit 通常不在任何用户分支上，只被 store ref 的 keepalive 链间接引用。

keepalive 用空树 `4b825dc...`（git 著名 empty tree），本身不含文件。它的价值是：一根 ref 吊住很多快照 parent，而不是 `refs/pi-rewind/<每条消息>`。并发更新 store 时最多重试 5 次 CAS。

忽略的文件、空目录：不在 tree 里，恢复时也不会被变回来。这是模型边界，不是漏测。

同一棵 tree sha 连续拍两次，会复用 `lastExact` 里的 commit，避免对象库里堆「内容完全一样、只是消息不同」的重复 snapshot commit。删工作区路径前会检查目标仍在仓库根之内，拒绝 `..` 逃出——精确恢复可以删文件，但不可以删到仓库外面。

## 7. 纵向链路二：fork / tree 时把文件恢复回去

宿主在跳转 **之前** 问扩展：`session_before_fork`、`session_before_tree`。扩展可以 `{ cancel: true }` 拦住整次跳转。

有 UI 时大致选项：

- Conversation only：只分叉对话，文件保持现在这样。仍会给「现在」拍一张，免得这条新会话后面没基准。
- Restore all：文件回到目标消息的快照，对话也走目标节点。
- Code only：文件回到快照，对话继续当前这条（tree 路径上的「只改文件」）。
- Undo last file rewind：回到恢复前刚拍的那张 undo 快照。

无 UI（例如脚本）：不弹选择，行为是「给现在拍照，文件不动」。不要假设 headless 会自动精确回档。

恢复步骤：

```text
解析目标 sha（本会话 → 祖先账本）
  → 再拍当前树，当作 undo
  → 若当前树 == 目标树：声明没改，跳过 restore
  → 算出目标里已经删掉的路径，先从工作区删掉
  → git restore --source=<快照 commit> --worktree -- .
  → 子模块：只允许 gitlink 指向的 commit 在本地存在，然后 detach checkout
  → 校验恢复后的 tree sha 对得上，否则当成失败
```

注意 `--worktree`：改的是工作区文件，不是把你的分支 reset 到快照。你 `git status` 很可能会变脏——这是预期，因为 HEAD 还在原分支，文件却回到了旧树。

强制「只对话、不改文件」的来源是白名单，例如 `fork-from-first`。自定义 compaction 可以触发一次检查点绑定。这些名单是源码里的 `Set`，不是用户配置。

fork 当时若恢复了文件，扩展会再写一条 `rewind-fork-pending`，把「新会话开工时应视作当前的 sha / undo sha」交给子会话。子会话 `session_start` 读到它，才不会把「fork 之后的工作区」误当成「这条新时间线从来没有检查点」。tree 跳转用另一块 `pendingTreeState`：恢复发生在 `session_before_tree`，真正的 `session_tree` 到来时才把这次操作写成 `rewind-op`。before 钩子失败会 `{ cancel: true }`，宿主不应再改对话位置——文件若已半恢复，这次会被当成错误而不是静默成功。

`git restore --source=... --worktree -- .` 只覆盖还存在于目标树里的路径。源码因此先算「当前树有、目标树无」的路径并删掉，否则旧文件会变成未跟踪垃圾，下一次拍照又把它们拍回去。这是精确恢复能成立的前提，不是优化。

## 8. 纵向链路三：retention 到底删什么

默认 **不 retention**。不配 `rewind.retention` 就是无限保留精确历史（只要 git 对象还在、jsonl 还在）。

打开之后，扫描会收集「还被账本引用的快照」，按 `maxAgeDays` / `maxSnapshots` 做候选，可选 `pinLabeledEntries` 钉住带标签的消息。然后它重写 `refs/pi-rewind/store` 的 keepalive 链，让不再需要的快照变得不可达，再 best-effort `git gc --auto`。

它 **不** 改写 session jsonl。所以：

- 账本条目会一直变长（append-only）。
- 过期的 sha 可能还写在 jsonl 里，只是对象没了。解析时当「这个点没有精确文件恢复」。
- 启动扫描有 `startupBudgetMs`，超时就跳过并警告，避免一打开 Pi 就卡在扫历史。

`RETENTION_SWEEP_THRESHOLD = 50`：新快照攒一批才扫，避免每拍一张就 gc。startup 那次故意不 gc，免得和正在进行的拍照抢锁。

## 9. 边界、概念区分、常见误区

**精确恢复 ≠ 工作区克隆。** ignore 规则外的文件、空目录、子模块工作区脏文件，都不在模型内。子模块增删路径直接拒绝。

**store ref ≠ 账本。** `git rev-parse refs/pi-rewind/store` 只能证明「吊绳还在」。要对账去 session 文件里搜 `"customType":"rewind-`。

**恢复文件 ≠ 移动分支。** 看 `git log` 不会出现「突然跳到 pi rewind snapshot」。看工作区和 `git status` 才会发现。

**compaction 压缩聊天 ≠ 丢掉检查点。** 绑定写在自定义条目里；compact hook 还会给 compaction 节点补一个绑定。但宿主若丢弃了整段 jsonl，账本当然一起没。

**fork 后的新会话不是自动带一份新的 git 分支。** 它继承对象库和 store ref，账本靠 `parentSession` 回溯。

**安装器不是运行时。** 改恢复算法只改 `index.ts`（以及它的测试）。`install.js` 动的是用户机器上的扩展副本。

## 10. 失败形态与排错

| 现象 | 先查哪一层 | 常见原因 |
|---|---|---|
| 选项里没有 Restore all | 解析层 | 目标节点不是可恢复类型；祖先账本里没有绑定；对象已被 gc |
| 一恢复就报 submodule | 拍照/恢复体检 | 脏子模块、未 init、嵌套 submodule、本地缺那个 gitlink commit |
| 恢复成功但分支名变了 | —— | 不该发生。若变了，不是这个扩展的 restore 路径（它不 checkout 用户 HEAD） |
| 恢复后大量 untracked | 模型边界 | 那些文件当时被 ignore，或恢复后新产生 |
| 状态栏一直不更新 | UI | `ctx.hasUI` 为 false；或 `updateStatus` 被非 git 仓库短路 |
| 打开 Pi 很慢并提示 sweep skipped | retention | 会话文件太多 / `startupBudgetMs` 太紧 |
| 卸载后对象还在 | 吊绳 | 要自己 `git update-ref -d refs/pi-rewind/store`，扩展卸载不管 gc |

## 11. 总结：可验证的稳定事实

1. 账本在 session jsonl，文件内容在 git 对象库，`refs/pi-rewind/store` 只负责别被 gc。
2. 拍照和恢复都 **不移动用户 HEAD**；恢复用 `git restore --worktree`。
3. 没有常驻 rewind 进程。hook 跑在当前 Pi 进程里，git 是子进程。
4. 不是 git 仓库 = 不拍照。坏 `settings.json` 不会关闭 rewind，只是不用 retention。
5. retention 修剪的是可达性，不是对话历史。

主线：

```text
消息节点 ──绑定──► 快照 commit ──parent──► store keepalive ──ref──► refs/pi-rewind/store
                ▲
                └── 恢复时：先拍 undo，再 restore 工作区，HEAD 不动
```

## 12. 源码阅读顺序

几乎全部逻辑在一个 `index.ts` 里。按块读，不要按「有多少 export」读。

1. 文件顶部的 `STORE_REF`、`RETENTION_VERSION`、settings 读取：看了能懂三份权威。
2. `captureWorktreeTree` / `appendSnapshotToStore` / `createStoreKeepaliveCommit`：拍照 + 吊绳。
3. `restoreCommitExactly` 以及子模块 `UnsupportedSubmoduleStateError`：恢复的拒绝条件。
4. `appendRewindTurn` / `appendRewindOp` / `reconstructState`：账本读写与内存映射。
5. `pi.on("session_before_fork")` 和 `session_before_tree`：用户可见的选择和 cancel 语义。
6. `turn_start` / `turn_end` / `session_compact` / `session_start`：何时拍照、何时重放账本。
7. `runRetentionSweep`：只改 ref、不改 jsonl。
8. `index.test.ts`：行为合同。改「HEAD 会不会动」「脏子模块能不能恢复」，先改测试。
9. `install.js`：只在关心用户机器遗留 hooks 目录时读。

本地冒烟：在一个 git 仓库里开 Pi，让 Agent 改一个被跟踪的文件，`/fork` 选更早的用户消息，选 “Restore all”。工作区文件回到旧内容、`git status` 变脏、`git branch --show-current` 不变，即主链通了。再 `git rev-parse refs/pi-rewind/store` 应能得到一个 commit。

对照：同一操作后 `git log -1 --oneline` 仍应是你原来的分支尖，而不是 `pi rewind snapshot`。

## 参考资料

- [pi-rewind-hook README](https://github.com/nicobailon/pi-rewind-hook)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- git 相关原语：`write-tree`、`commit-tree`、`update-ref`、`restore --worktree`（本扩展有意不用用户级 `commit` / `checkout`）
