# 看懂 pi-kanban0：看板就是一块 Markdown，面板和工具都围着它转

> 本文面向已经会用 Pi、想搞清「`/kanban` 打开的是服务还是文件、Agent 改的和你在面板里改的是不是同一块板」的读者。需要知道 Pi 扩展随宿主进程加载、TUI 可以挂自定义 overlay。
>
> **本文定位：小项目、二次开发深度。** 实现几乎就九个 `src/*.ts`，但「项目板 / 全局板 / 只读不建文件 / 盘上冲突」这几条边界比 UI 热键重要。布局数字、默认五列文案、快捷键属于易变细节。
>
> 源码基线：本仓库 `pi-kanban0`，包版本 `0.3.1`，peer Pi `>=0.83.0`，Node `>=22.19.0`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13ed69a55f94889194018f652adf628ddc4b`（2026-09-03）。上游：[AHGGG/pi-kanban0](https://github.com/AHGGG/pi-kanban0)。入口：`package.json` → `pi.extensions = ["./src/index.ts"]`。

## 1. TLDR：它不是看板服务器，也不是 Obsidian 插件

```text
~/.pi/agent/pi-kanban0/kanban.md     ← 全局板（跨项目）
<project>/.pi/kanban.md              ← 项目板（可进 git，也可 gitignore）
        │
        │  权威源永远是这个文件的当前字节
        ▼
   BoardStore（读入内存文档 + 记住上次写入的快照）
        │
        ├─ /kanban  → TUI overlay 面板（同一 Pi 进程，阻塞式 custom UI）
        └─ 工具 kanban_board → Agent 按标题改同一文件（sequential）
```

所以它**不是**：

- 不是 HTTP 服务、不是 WebSocket、不是 SQLite。关掉 Pi，板上的卡片还在文件里；没有 Pi，就没有面板，也没有工具。
- 不是 Obsidian Kanban 运行时。`/kanban import` 只**拷贝**一份 Markdown 进来，源文件从此再也不被碰。
- 不是常驻 widget。`/kanban` 打开 overlay，`q` / Esc 关掉；没有 `session_start` 钩子在后台盯着文件。
- 不是「Agent 有一份板、人有一份板」。两边都 `new BoardStore(path)`，冲突用字节快照仲裁。

正面定义：**一块（最多两块）本地 Markdown 看板，人用键盘 overlay 改，Agent 用一把 sequential 工具改，写入都是 temp+rename。**

## 2. 为什么要把「板」做成文件而不是状态

正例：你希望这块 Todo 能进 git、能用普通编辑器改、能让 Agent 在你没开面板时也动一动。那权威源就只能是磁盘上的 Markdown，解析器必须容忍「看不懂的段落」（YAML、代码块）当 raw 原样写回。

反例：把列和卡片放进扩展内存或 `settings.json`。一更新扩展数据就没了；Agent 和 TUI 也没法共享；你也无法用 `git diff` 看今天挪了哪张卡。

四行职责：

| 谁 | 管什么 |
| -- | ------ |
| `kanban.md` | 列、卡、勾选、时间、标签、以及所有「看不懂但必须留下」的原文 |
| `BoardStore` | 乐观并发：内存文档 vs 盘上快照；冲突就拒绝写入 |
| TUI 面板 | 给键盘用户的视图；改一下立刻 mutate 写盘 |
| `kanban_board` 工具 | 给 Agent 的同一套 mutate；按**标题**找卡，不按内部 id |

布局（板高、卡片行数）刻意不进 `kanban.md`，而进 `~/.pi/agent/pi-kanban0/settings.json`。那是显示偏好，不是板的内容。改完要**下次** `/kanban` 才生效——面板自己都这么通知你。

## 3. 先看整体架构，不急着看类名

文档视角：

```text
命令层     /kanban [project|global]  /kanban import <file>
     ↓
选板层     项目文件存在？→ 全局文件存在？→ 键盘菜单新建
     ↓
存储层     读文件 → 解析成「前缀 + 列 + (卡片|raw 块)」
     ↓
交互层     overlay 面板  或  工具 action
     ↓
写回层     serialize → 与快照比对 → temp 文件 rename 覆盖
```

进程真相更窄：整份扩展活在**当前 Pi 宿主进程**里。没有第二个进程，没有锁文件跨 Pi 实例。两个 Pi 窗口同时打开同一块板，靠的是「写前再读盘，字节变了就 `BoardConflictError`」，不是文件锁。

工厂（`src/index.ts` 默认导出）只做两件事，没有 `pi.on(...)`：

1. `registerKanbanTool(pi)` —— 注册 `kanban_board`；
2. `pi.registerCommand("kanban", …)` —— TUI 专用命令。

`ctx.mode !== "tui"` 时命令直接报错退出。工具在 headless / rpc 里仍可用，这是「人看面板、Agent 写文件」能分开的原因。

## 4. 运行形态：overlay 占用前台，工具跟会话走

| 形态 | 谁拉起 | 活多久 | 改磁盘吗 |
| ---- | ------ | ------ | -------- |
| `/kanban` overlay | 你在 TUI 敲命令 | `ctx.ui.custom` 循环直到 close | 每次 mutate 立即写 |
| `kanban_board` | 模型发起 tool call | 这一次 execute | list 只读；写操作 mutate |
| 扩展工厂 | Pi 加载扩展 | 整个会话 | 本身不写 |

overlay 锚在 `bottom-center`、宽度 100%、底部留 4 行给 Pi 的编辑区/状态行。这不是独立窗口，是盖在对话上面的自定义控件。`runPanel` 是 `for(;;)`：面板 `done(action)` 之后，命令层去跑 select/input/confirm，再回来继续 overlay。所以「打开时间选择」看起来像嵌了菜单，其实是 overlay 先关一层、宿主 UI 插一脚、再开。

没有 daemon，没有 file watcher。盘上被外部改了，面板不会自动刷新；脚注写着 *press r to reload*。`r` 才 `store.reload()`。Agent 每次 tool call **新建**一个 `BoardStore`，等于每次从盘读——所以你刚在编辑器里保存的内容，下一轮工具能看见；但同一轮面板如果还开着，它手里的快照可能已经脏了。

`getAgentDir()` 来自 pi-coding-agent，不是 `process.cwd()`。全局板和 `settings.json` 都挂在用户 Agent 目录下，所以换项目 cwd 不会把显示偏好带走，也不会把全局 Todo 写进仓库。反过来，项目板永远相对 `ctx.cwd`，跟你是不是在 monorepo 子目录启动 Pi 有关——cwd 指错，就会打开另一块 `.pi/kanban.md`，或弹出「要不要新建」。

新建文件用 `writeFileSync(..., {flag:"wx"})`：不存在才写默认五列（Inbox / Todo / In Progress / Review / Done），存在就当已有。导入是另一条原子 rename，源文件只读校验（至少要能 parse 出 `##` 列）。

## 5. 两块板，怎么选，谁也不会自动切到另一块

路径约定（`project-board.ts`）：

```text
项目板  resolve(cwd, ".pi/kanban.md")
全局板  resolve(getAgentDir(), "pi-kanban0/kanban.md")
        默认即 ~/.pi/agent/pi-kanban0/kanban.md
```

`/kanban` 无参数：

1. 项目板是普通文件 → 打开它；
2. 否则全局板是普通文件 → 打开它；
3. 否则 `ui.select`：创建项目板还是全局板。Esc 取消，什么都不建。

`/kanban project` / `/kanban global` 跳过菜单，**没有就创建**。

工具的 `scope`：

| scope | list | 写操作 |
| ----- | ---- | ------ |
| `auto`（默认） | `findExistingBoard`：项目优先，否则全局；两都没有 → 返回 undefined，**不建** | 同左，没有板就抛错，让模型先问人 |
| `project` / `global` | `findScopedBoard`，没有就失败 | `ensureScopedBoard`，没有就创建 |

0.3.1 的要点就在这里：只读 list 绝不能顺手建一块空板。显式 scope 也不会在「这边没有」时偷切到另一边。

导入目标同样：已有项目板就进项目板，否则已有全局板，否则菜单。覆盖已有目标必须 `ui.confirm`。导入后运行时只认那份拷贝。

## 6. 纵向链路一：人在面板上挪一张卡

```text
1. 宿主层     你键入 /kanban（同步命令 handler）
2. 选板层     同步存在性检查；可能异步弹出 select
3. 解析层     BoardStore 构造：readFile + parseKanbanMarkdown
4. 覆盖层     ctx.ui.custom overlay（异步，直到面板 done）
5. 输入层     handleInput：方向键改 selected*，热键发出 PanelAction
6. 变更层     store.mutate：先再读盘比对快照 → 改内存文档 → serialize
7. 落盘层     同目录 .pi-kanban0-<pid>-<ts>.tmp → rename 成 kanban.md
```

完成 ≠ 就绪：

- overlay 画出来 ≠ 这是「活动看板服务」。它只是这次命令的 UI。
- mutate 返回 ≠ 别的 Pi 窗口里的面板已更新。那边快照仍是旧字节，下一次写入会被拒。
- `settings.json` 写成功 ≠ 当前 overlay 变高。文案写得很清楚：*applies next time /kanban opens*。
- 卡片内部 id（`card:${列号}:${卡号}`）在这一次内存文档里稳定；**重新 parse 会按新位置重编号**。面板闭包用这次的 id 还能找到卡；工具不走 id，走标题。

冲突策略：写前 `readFileSync` 和构造时/上次写入的 `snapshot` 做字符串全等。不等 → 抛 `BoardConflictError`，mutate 里若已经改了内存会用 `before` 再 parse 滚回去。面板提示按 `r`。没有合并、没有 diff3。

删除列会连卡片一起删，有卡时先 confirm。板必须至少留一列——工具侧同样强制。

面板热键把「改文档」和「问宿主 UI」拆开。方向键、空格勾选、`r` 重载、`q`/Esc 关闭，都在 overlay 内消化；`a` 加卡、`e` 编辑、`d` 删除、`@` 时间、`#` 标签、`c` 列菜单，则 `done()` 把控制权交回 `runPanel`，由 `ctx.ui.input` / `confirm` / `select` 接着干。这就是为什么加一张卡时 overlay 会先消失一帧：不是又开了个进程，是 custom UI 循环的下一圈。

空格在面板里是 **toggle** 勾选，和工具的 `set_done` 故意相反——人按一下就翻转，模型重试不许翻转。

## 7. 纵向链路二：Agent 说「把登录页测试挪到 In Progress」

```text
1. 模型层      决定调 kanban_board（参数里是 action / card / column …）
2. 选板层      resolveKanbanBoardLocation(scope, cwd)     同步
3. 读盘层      new BoardStore(path)  每次 tool call 一次
4. 定位层      列名、卡标题都是大小写不敏感精确匹配
5. 变更层      与面板同一套 markdown-board 函数 + mutate
6. 返回层      一句人话 + details.{action,path,scope,created}
```

`executionMode: "sequential"`：同一会话里这把工具不会并行两次，避免自己和自己抢快照。这**挡不住**另一个 Pi 进程，也挡不住你同时开着 overlay。

定位规则（二次开发最容易踩）：

- 找卡靠 **title 全等**（locale 不敏感），不是模糊搜，不是 id。
- 同名卡多于一张 → 必须再给当前 `column`，否则拒绝猜测。
- 时间 `@\{…\}`、标签 `#foo` / `#\{带空格\}` 写在任务下面的缩进行，**不是标题的一部分**，所以改时间不会让下一轮 title 匹配失败。
- `set_done` 是显式勾选，不是 toggle，避免模型重试把完成态弹回来。
- `list` 的 `query` 才是子串过滤，扫的是 `card.raw`（含正文），默认最多 100 张。
- 删列带卡必须 `deleteCards=true`，promptSnippet 也写了 destructive 要用户明确说。

工具和面板共享 mutate，但不共享打开中的 `BoardStore` 实例。Agent 改完，你还开着的 overlay 下次按键去写，就会撞冲突——这是设计，不是漏了刷新。

## 8. Markdown 合同：列是二级标题，卡是任务，其余是 raw

解析器认的列：顶层 `## Column`（围栏代码块里的 `##` 不算，有 fence 状态机）。一张卡：顶层 `- [ ]` / `- [x]` / `*` `+` 以及大写 `X`。后续缩进行算卡的 body；空行先挂起，遇到非缩进再决定是卡的一部分还是 raw。

序列化按内存文档拼回去，保留：

- 文件开头到第一列之前的 `prefix`（标题、YAML、说明）；
- 每列里非卡片的 `raw` 块；
- 原换行风格（`\n` / `\r\n` / `\r`）。

`serializeKanbanMarkdown` 几乎不做美化：`prefix + 每列 headingRaw + 每个 block.raw`。卡片怎么进来就怎么出去，这是「未知 YAML / 代码块能活下来」的真正原因——它们从来没被解析成结构化字段，只是某列里的 raw 块。二次开发如果在 mutate 里改了 `title` 却忘了同步 `raw`，写回盘上的仍是旧任务行。

因此「用普通编辑器在 Inbox 上面写一段话」不会被第一次 `/kanban` 吃掉。反过来：没有一个 `##` 列，parse 直接抛 `No Kanban columns found`，导入也会失败。复制到剪贴板走另一条函数，会丢掉时间和标签，避免把 `@{}` 当标题粘出去。

时间快捷（`@` 键）用的是 **Pi 进程本地时区** 的今天 / 现在 / 明天，不是 UTC。自定义时间只是一段写进 `@\{}` 的字符串，解析器不当日历校验。

## 9. 边界、误区、失败形态

**项目板和全局板可以同时存在。** auto 永远先项目。你在仓库里开 `/kanban` 看不到全局板上的事，这不是丢数据。

**cwd 是 Pi 的项目目录，不是「面板标题上那个文件的目录」。** Agent 在别的 workspace 调工具，会解析到另一块 `.pi/kanban.md`。

**内部 id 不是 API。** 不要在二次开发里把 `card:0:3` 存到外部系统当主键，reload 后 3 可能是另一张卡。对外稳定键是「列标题 + 卡标题」，同名再加人工消歧。

误区 1：「装了扩展就有一块默认板。」——没有任何 `session_start` 去 ensure。list 不建；只有 `/kanban` 选创建、显式 scope 的写操作、或 import 才会落文件。

误区 2：「开着面板，Agent 改完屏幕会动。」——不会。要 `r`，或关掉重开。

误区 3：「这是 Obsidian 同步。」——import 是一次性拷贝。之后两边各改各的。

误区 4：「改显示高度就是改看板。」——`settings.json` 与 `kanban.md` 分家；板高保存成功时当前 overlay 仍是旧高度。

| 现象 | 先查哪一层 |
| ---- | ---------- |
| `/kanban` 报需要 TUI | 命令层，headless/rpc 请改用工具 |
| 工具说 No … board exists | 选板层，list/auto 不创建；先问人 `/kanban` 或带 scope 写一次 |
| Card title is ambiguous | 定位层，同名卡，补 column |
| Board changed on disk | 存储层，外部或另一实例改过；面板按 r，不要连点写入 |
| 导入失败 No Kanban columns | 源文件没有顶层 `##`，或列标题都在代码围栏里 |
| 改了 settings 板还是那么高 | 显示层，关了 `/kanban` 再开 |
| 勾选来回跳 | 不要用 toggle 语义；工具必须 `set_done` |

没有网络、没有队列，失败形态几乎都是「文件不存在 / 解析不了 / 快照不对 / 标题撞车」。

工具的 `details.created` 值得看一眼：auto/list 路径上它应当总是 `false`；若一次 `add_card` 带着显式 `scope: "project"` 回来 `created: true`，说明这次写入顺手建了默认五列空板——这是允许的，但不是 list 的行为。测试里把这条写成合同（`test/kanban-tool.test.ts`），改选板逻辑时先跑它。

## 10. 总结：四件能核对的事 + 一条主线

1. 权威源是 Markdown 文件，不是进程内存；默认路径就两处：项目 `.pi/kanban.md`、全局 `getAgentDir()/pi-kanban0/kanban.md`。
2. 扩展不常驻、不监听；TUI overlay 和 `kanban_board` 都是用完即走，每次写盘都原子 rename。
3. auto 选板「项目优先、否则全局」；只读 list 不建文件；显式 scope 不偷切另一块板。
4. 人机共享同一套 parse/mutate，但**不共享**打开中的 Store；并发靠整文件快照，冲突要人按 `r`。

```text
kanban.md  ──parse──►  内存文档
    ▲                    │
    └──rename── mutate ◄─┼── 面板热键
                         └── 工具 action（按标题）
```

## 11. 深入通道：源码阅读顺序

1. `src/index.ts` 默认导出 + `chooseBoardLocation` / `runPanel`。看了能懂命令只在 TUI、overlay 循环如何把菜单插进去。
2. `src/project-board.ts`。看了能懂两块板的路径、wx 创建、import 不改源文件。
3. `src/board-store.ts`。看了能懂快照冲突和原子写；文件很短，建议整份读。
4. `src/markdown-board.ts` + `src/board-model.ts`。看了能懂 `##` / 任务 / raw / fence、id 只是这次 parse 的坐标。
5. `src/kanban-tool.ts` 的 `resolveKanbanBoardLocation` 与 `requireCard`。看了能懂 list 不建板、标题消歧、`set_done`。
6. `src/kanban-panel.ts` 的 `handleInput` 与 conflict 分支。看了能懂 `r` / overlay 热键，不必先啃 render。
7. `src/kanban-settings.ts`、`src/time-shortcuts.ts`。看了能懂显示偏好与「今天」用哪套时钟。
8. `test/board-store.test.ts`、`test/kanban-tool.test.ts`、`test/project-board.test.ts`。行为合同：冲突、list 不建、scope 不串台。

本地冒烟：在一个没有 `.pi/kanban.md` 的目录 `pi`，`/kanban` 应弹出选板；建成后文件里有五个 `##`。另开编辑器改一行，回到面板直接改卡，应提示 reload。对 Agent 说「列出当前看板」不应在空项目里凭空建文件。

`npm test` 走 vitest，不需要飞书或 native helper。`scripts/verify-board.ts` 是对着真实 Markdown 跑一遍 parse/serialize 的手工核对，改解析器时比单测更接近「用户拿 Obsidian 文件砸进来」的形状。

## 参考资料

- [pi-kanban0 README](https://github.com/AHGGG/pi-kanban0)
- 中文说明：仓库内 `pi-kanban0/README.zh-CN.md`
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- 兼容导入格式只认顶层 `##` 与 Markdown 任务，其它内容当 raw 保存；不依赖任何 Obsidian 插件路径
