# 看懂 pi-review-loop：检查点在会话里，窗口在进程外

> 本文面向已经会用 Pi、想搞清「`/diff-review` 开的到底是 TUI 还是网页、下次 diff 相对谁、批注怎么回到模型」的读者。需要知道 Pi 有会话分支（session branch），扩展可以往上面追加 custom entry。
>
> **本文定位：二次开发深度。** 稳定认知放在三进程切面（TUI 命令 / Controller / Glimpse webview）、检查点权威、两条 diff 基线上。窗口尺寸、Monaco 语言包、toast 文案属于易变细节。包版本 `0.3.0`。
>
> 源码基线：本仓库 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游：[earendil-works/pi-review-loop](https://github.com/earendil-works/pi-review-loop)。原生窗口：[hazat/glimpse](https://github.com/hazat/glimpse)（npm：`glimpseui`）。

## 1. TLDR：它做的事情可以压成两条链路

Agent 一边改文件，人一边看增量 diff。点 **Mark reviewed** 不是 `git commit`，是在**当前会话分支**上钉一枚检查点；下一次打开窗口，默认只显示这枚之后又变的东西。

打开窗口（命令立刻返回）：

```text
Pi TUI 输入 /diff-review
  → 扩展确认 ctx.mode === "tui"
  → ReviewController.openOrShow
  → 读 git 仓库根 + 会话里最近一枚 checkpoint
  → Glimpse 原生窗口加载 web/dist/index.html（自包含 Monaco）
  → 窗口发 ready ↔ 宿主推 workspace
```

提交一次审查：

```text
webview 收集行内/文件级批注
  → submit-review
  → Controller：composeFeedback + createCheckpoint
  → pi.appendEntry("review-loop/checkpoint", …)   ← 权威落盘点
  → 有批注：pasteToEditor 塞进 Pi 编辑器（不是自动进模型上下文）
  → 窗口切到新基线，继续 hang 着看后面的增量
```

所以它不是：

- **不是** Pi TUI 里的 overlay / widget。命令跑在 TUI 模式里，窗口是 Glimpse 拉起来的**操作系统窗口**。
- **不是** 独立 web 服务。没有 localhost 端口；HTML 是打包进扩展的单文件，塞进 webview。
- **不是** `git diff` 的 GUI 封装。默认基线是「上次 Mark reviewed 时的工作区快照」，不是 HEAD。`vs HEAD` 是第二种模式。
- **不是** 把批注写进 PR / 写进 git notes。检查点活在 session custom entry；`--no-session` 下只活到这个进程结束。
- **不是** 给模型自动注入的记忆。README 写明 custom entry **不参与** model context；模型要看见批注，得靠 paste 进编辑器之后你按回车。

正面定义：它是挂在 Pi 上的 **持久增量审查环**——Controller 在 Pi 进程里盯仓库、管检查点；人在进程外的 Monaco 窗口里批；提交把「当前工作区」冻进会话分支。

权威数据源：

```text
会话分支上 customType = "review-loop/checkpoint" 的条目
        = 审查基线的权威（gzip+base64 的脏文件快照 + headSha）

当前工作区磁盘 + git HEAD
        = 右侧「现在」的权威

Pi 编辑器里贴进去的那段 Please address…
        = 给模型看的派生文本，不是检查点本身

webview 里的 Monaco 缓冲
        = 某一瞬间的视图；磁盘变了靠 chokidar 刷新
```

## 2. 为什么不能只开一个 `git diff` 面板

编码 Agent 的工作方式是连续改：你审完 auth，它又去改 cookie。如果每次都对 HEAD diff，你已经看过的 hunk 会反复出现；如果审完就 commit，又把「还没准备好进历史」的中间态写进 git。

正例：一次重构里，你对 `src/auth.ts` 留了两条行内意见，点 Mark reviewed。检查点把当时所有脏文件（含未跟踪）冻进会话。Agent 继续改 `src/auth.ts` 和新建 `src/session.ts`。窗口默认 **Since review** 只显示这两处相对检查点的增量。

反例：不要把检查点当成 stash 或 commit。它不改 git 索引，也不恢复文件。也不要以为批注提交后模型已经在读——`pasteToEditor` 只是把文本放到 Pi 的输入框，**发送仍是你的动作**。

所以架构判断是：

```text
人管「这段 diff 过不过、批什么」（质量）
Controller 管「基线是哪一版工作区、窗口怎么刷新」（流程）
会话 custom entry 是交接结果（权威）
编辑器里的 feedback 文本只是给模型的便条
```

## 3. 先看整体架构，不急着看类名

文档视角：

```text
命令层          /diff-review（只在 TUI 模式注册成功后能开窗）
        ↓
控制层          ReviewController（Pi 进程内，单例到窗口关掉）
        ↓
工作区模型      两种扫描：相对 checkpoint / 相对 HEAD
        ↓
持久层          sessionManager 分支上的 checkpoint 条目
        ↓
展示层          Glimpse 窗口 → 自包含 HTML → Monaco diff
```

进程真相和文档视角的差异是本文要盯住的：

```text
pi 进程（TUI 还在跑）
  ├─ 扩展 index.ts：注册命令、session_shutdown 时 close
  ├─ ReviewController：消息泵、chokidar、enqueue 串行刷新
  ├─ WorkspaceModel + git.ts：pi.exec("git", …) 读仓库
  ├─ pi.appendEntry / getBranch：检查点读写
  └─ ctx.ui.pasteToEditor / notify：回到 TUI 编辑器
        │
        │ glimpseui.open(html)     ← 不是 HTTP
        ▼
Glimpse 原生窗口（独立 OS 窗口，webview）
  └─ web/dist/index.html
        Monaco 左右 diff + 侧栏文件树
        glimpse.send(WindowMessage)  → 宿主
        宿主 window.send("window.__reviewReceive(...)") → 页面
```

三句话切面：

1. **TUI**：只负责发出 `/diff-review`、弹出 notify、接收 paste 进编辑器。没有文件树，没有 diff。print / RPC 模式直接拒绝。
2. **Controller**：唯一知道 git、会话、检查点的地方。窗口只是它的显示器。
3. **Web**：纯视图。不知道 git，不写磁盘，不碰 session。文件内容按需 `request-file` 来。

`/diff-review` 再按一次：窗口已开就 `show()` 置前，**不会**新建第二枚 Controller。窗口关掉（人关、Pi shutdown、切会话、reload 扩展）Controller 置 null；下次命令重新 `new`。

## 4. 运行形态：寄生扩展 + 一个原生窗口

谁拉起：`pi install git:github.com/earendil-works/pi-review-loop`，Pi 加载 `src/index.ts`。谁保活：没有 daemon。Pi 退出，`session_shutdown` 里 `controller.close()`，Glimpse 窗口一起没。

前置条件（缺一个就开不了或立刻失败）：

- Node 20+
- 当前 `ctx.cwd` 在 git 仓库里（`git rev-parse --show-toplevel`）
- `ctx.mode === "tui"`
- 平台被 Glimpse 支持（macOS / Linux / Windows）

命令**立即返回**，不替换 Pi 编辑器。这是产品决定：审查窗口和对话输入要同时活着。Agent 继续 write 文件时，chokidar 在仓库根上听（忽略 `.git` 和 `node_modules`），100ms debounce 后 `model.refresh()` 再推一条 `workspace`。刷新串在 `this.operation` 队列上，避免并发 git 扫描打架。

没有常驻 HTTP。`scripts/build-web.mjs` 把 `web/src/app.ts`、Monaco worker、样式、codicon 字体全部 base64 进 **一张** `web/dist/index.html`。改前端必须 `npm run build:web`，扩展运行时 `loadReviewHtml()` 只 `readFileSync` 这份产物。源码和产物不同步时，窗口还是旧 UI。

`--no-session`：检查点写在内存会话上，进程结束即丢。会话 fork / 切分支：`latestCheckpoint` 从**当前** `getBranch()` 倒着找，所以审查状态跟着会话分支走，这是故意的。

## 5. 纵向链路一：打开窗口到第一屏 diff

```text
1. 命令层     /diff-review，非 tui 则 notify 并 return     同步
2. 仓库层     getRepoRoot(ctx.cwd)                         同步等 git
3. 基线层     latestCheckpoint：倒扫 session 分支
              customType === "review-loop/checkpoint"
              且 repoRoot 对得上才算
4. 扫描层     WorkspaceModel.refresh
              并行：scanAgainstCheckpoint + scanAgainstHead + 分支名
5. 窗口层     glimpseui.open(html, 1480×920)
6. 握手层     页面每 250ms 发 ready，直到收到 workspace
              （宿主用 window.send 注入 JS 调用 __reviewReceive）
```

完成 ≠ 就绪：

- 命令返回 ≠ 窗口已画出 diff。握手靠页面轮询 `ready`；宿主 `send` 包了一层 `escapeInline`（防 HTML 解析吃掉 JSON）。
- `WorkspaceModel.create` 成功 ≠ 侧栏有文件。工作区相对基线没变化时，files 为空，这是正常的「已审完」。
- 打开时会把两种 mode 都扫一遍，但 UI 默认 **Since review**（`checkpoint`）。没有检查点时，checkpoint 基线退化成「打开窗口那一刻的 HEAD + 空 overrides」——第一次审查看到的就是当时相对 HEAD 的脏文件。

两种 mode 的人话：

```text
Since review (checkpoint)
  左：上次 Mark reviewed 冻住的内容（overrides 命中则用快照，否则用当时 headSha）
  右：现在磁盘

vs HEAD (head)
  左：git HEAD
  右：现在磁盘
```

`pendingFiles` 永远按 checkpoint 模式算——工具栏「还有多少没审」不跟你切到 vs HEAD 走。指纹是内容 sha256，删除用字面 `"deleted"`。

## 6. 纵向链路二：批一条意见，钉一枚检查点

```text
1. 展示层     悬停行号 → + → Monaco view zone 里写批注
              也可在草稿框写文件级意见
2. 提交层     Mark reviewed → { type: "submit-review", comments }
3. 合成层     composeFeedback：空 body 丢掉；
              行内标 path:line (reviewed|HEAD|current)
4. 快照层     createCheckpoint：
              dirtyPaths = git status --porcelain -z --untracked-files=all
              每个脏路径 readCurrent → gzip+base64
              记下当时 headSha、reviewedPaths、feedback 原文
5. 会话层     pi.appendEntry("review-loop/checkpoint", checkpoint)
              ← 这是权威写入，同步进当前分支
6. 便条层     feedback 非空 → ctx.ui.pasteToEditor(feedback)
7. 视图层     model.setCheckpoint + refresh + 推 workspace
              窗口继续开着，基线换成刚刚这枚
```

完成 ≠ 就绪：

- **appendEntry 成功 ≠ 模型已经读到批注。** custom entry 不进 context。便条在编辑器里，你还没按回车。
- **Mark reviewed 成功 ≠ git 干净。** 工作区一行没动。下一轮 Since review 为空，只说明「相对这枚快照没再改」。
- **reviewedPaths ≠ 快照覆盖范围。** `createCheckpoint` 冻的是 **全部 dirtyPaths**（含未跟踪），`reviewedPaths` 只是当时 checkpoint 模式下的路径列表，给以后 UI 用。二次开发不要只恢复 reviewedPaths 以为能重放基线。
- 提交有 `submitting` 闩；失败才松开。前端按钮 5 秒后会自己 `updateSubmitButton`，那是 UI 防卡死，不是宿主超时。

编码：`encoding: "gzip+base64"`。删除的文件存 `{ state: "deleted" }`。`readCurrent` 按 **utf8** 读；二进制会被当成损坏文本塞进 Monaco——这是已知天花板，不是加密。

`latestCheckpoint` 倒序扫描，同一仓库多枚检查点只认最新。旧条目仍在分支历史上，fork 出去的会话会带着 fork 点之前那枚。

## 7. 纵向链路三：Agent 还在写，窗口怎么跟上

```text
chokidar "all"（ignoreInitial）
  → 路径必须落在 repoRoot 内
  → 100ms debounce
  → enqueue(model.refresh → send workspace)
  → 页面收到 workspace：保留滚动、按需 request-file
```

文件内容**不**随 workspace 全量推送。侧栏只带 path / status / fingerprint / mtime。点开某个文件才 `request-file`；fingerprint 变了才重新拉。这是为了让 Monaco 缓冲别在每次保存时闪掉。

宿主 `getFile` 找不到路径会回 `file-error`（「no longer changed in this mode」）——Agent 把文件改回基线后，这条会从列表消失，正在看的 diff 会失败。这是正确行为，不是丢消息。

窗口生命周期：

```text
开：/diff-review 且当前没有 window
关：人关窗口 / window error / session_shutdown（含切会话、reload、退出）
再开：必须再敲一次命令；不会在后台偷偷复活
```

## 8. 边界、概念区分、常见误区

**TUI 模式 ≠ TUI 窗口。** `ctx.mode === "tui"` 只是「Pi 正以交互终端跑」。审查 UI 在 Glimpse。在 print 模式跑 `pi -p` 调这个命令，只会 warning。

**检查点 ≠ HEAD ≠ 磁盘。** 三份东西。Since review 比较的是检查点快照和磁盘；vs HEAD 比较的是 git 和磁盘。检查点里的 `headSha` 是钉检查点时的 HEAD，用来在 overrides 没有某文件时回退读 `git show`。

**会话分支 ≠ git 分支。** git 分支名只显示在窗口顶栏。审查状态跟 Pi 的 session branch。README 原话：Session branching therefore also branches review state.

**批注 ≠ 记忆。** 不要和 `pi-memory` / observational ledger 混。检查点的 `feedback` 字段只是当时便条的副本，模型不会在下一轮 system prompt 里看见它。

常见误区：

1. 「这是个本地 web 服务，打开了 http://localhost。」没有。是 webview 加载打包 HTML。
2. 「Mark reviewed 等于我同意这些改动进 git。」git 无感。
3. 「切到 vs HEAD 再提交，基线就变成 HEAD。」提交始终 `createCheckpoint` 冻**当前脏工作区**；mode 只影响你看的 diff 和批注上的 (HEAD)/(reviewed) 标签。
4. 「reload 扩展窗口还在。」`session_shutdown` 会 close。要再 `/diff-review`。
5. 「和 pi 编辑器是同一个 Monaco。」不是。两个进程里两套编辑器；只有 paste 把文本送回 Pi。

## 9. 失败形态（现象 → 该查哪一层）

| 现象 | 先查 |
| --- | --- |
| 命令提示 requires interactive TUI | 是不是 `-p` / 非 TUI 宿主 |
| Could not open Review Loop | `git rev-parse` 失败：cwd 不在仓库 |
| 窗口打开但一直 Connecting | 页面 `ready` 没被宿主接到；Glimpse `send` / `__reviewReceive` |
| 侧栏是空的，明明工作区很脏 | 是不是已经有一枚检查点且之后没再改；切 vs HEAD 对照 |
| 刚保存的文件过两秒才出现 | 100ms debounce + git scan 队列；不是丢了 |
| 点 Mark reviewed 没进模型 | 看 Pi 编辑器是不是多了一段 Please address；那是便条，要你发送 |
| `--no-session` 下次打开忘了基线 | 预期：检查点没地方活 |
| 二进制文件 diff 乱码 | `readFile(..., "utf8")` 天花板 |
| 改了 `web/src` 窗口没变 | 忘了 `npm run build:web`，运行时只读 `web/dist` |

## 10. 总结：五条稳定事实 + 一条主线

1. 运行形态是 **Pi 进程里的 Controller + Glimpse 原生 webview**，不是 TUI 面板，也不是 HTTP 服务。
2. 权威是会话分支上的 `review-loop/checkpoint` 条目（脏文件 gzip 快照 + headSha），不是 git。
3. 默认 diff 基线是上一枚检查点；`vs HEAD` 是另一条扫描，提交仍冻工作区。
4. 批注合成文本只 `pasteToEditor`；custom entry 不进模型上下文。
5. 窗口跟 Pi 会话同生共死；命令可重复置前，reload / 切会话必须重开。

主线：

```text
TUI 发 /diff-review
  → Controller 在 Pi 进程盯 git + 会话检查点
  → Glimpse/Monaco 只是显示器
  → Mark reviewed 把当前工作区冻进 session 分支
  → 有批注就给 Pi 编辑器留一张便条
  → 窗口继续 hang，只显示这枚之后的增量
```

## 11. 深入通道：源码阅读顺序

1. `src/index.ts`  
   看了能懂：为什么非 TUI 直接拒绝、shutdown 为什么必须 close、Controller 如何单例到窗口关掉。
2. `src/types.ts` 的 `ReviewCheckpoint` / `WindowMessage` / `HostMessage`  
   看了能懂：跨进程合同和磁盘（会话）合同是两套消息。
3. `src/controller.ts` 的 `openOrShow` + `handleMessage` + `send`  
   看了能懂：握手、置前、提交闩、JS 注入回 webview。
4. `src/workspace.ts` 的 `refresh` / `state` / `checkpointBaseline`  
   看了能懂：没有检查点时基线如何退化、pendingFiles 为什么不跟 mode 走。
5. `src/git.ts` 的 `dirtyPaths` / `scanAgainstCheckpoint` / `createCheckpoint` / `encodeStored`  
   看了能懂：冻的是全部脏路径、overrides 和 reviewedPaths 不是一回事。
6. `src/prompt.ts`  
   看了能懂：模型最终可能读到的便条格式，十行内闭合。
7. `web/src/app.ts` 的 `send` / `__reviewReceive` / submit 按钮  
   看了能懂：视图如何主动拉文件、ready 轮询、提交后 5 秒自救。
8. `scripts/build-web.mjs` + `src/ui.ts`  
   看了能懂：为什么运行时只有一张 HTML，改 TSX 不等于改窗口。
9. `test/core.test.ts`  
   看了能懂：检查点之后改干净文件 / 未跟踪文件如何出现在下一轮 delta。比再读一遍 README 准。

本地冒烟：在一个脏 git 仓库里 `pi -e ./src/index.ts`，敲 `/diff-review`，应弹出 Glimpse 窗口而不是在终端里画 diff。Mark reviewed 一次，改一个文件，侧栏应只剩那一个。看 Pi 编辑器是否出现 `Please address the following review feedback:`——出现了还没发送，模型就还不知道。

二次开发时优先碰的缝：新增消息类型必须同时改 `types.ts` 两端；不要在 webview 里 `git`；不要把检查点改成写 `.git/`；paste 进编辑器是给人类的，想自动进模型要另接钩子，那是产品变更不是 bug fix。

## 参考资料

- [pi-review-loop README](https://github.com/earendil-works/pi-review-loop)
- [Glimpse](https://github.com/hazat/glimpse)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
