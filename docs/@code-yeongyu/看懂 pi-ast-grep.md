# 看懂 pi-ast-grep：给 Agent 一把按语法搜代码的刀

> 本文面向第一次接触 `pi-ast-grep`、但已经知道「Pi 是编码 Agent、扩展会往宿主里注册工具」的读者。重点不是罗列函数名，而是讲清：它解决什么问题、实际怎样活在机器上、一次搜索/改写怎么走完、失败时仓库会不会被改掉。
>
> **本文定位：小项目、二次开发深度。** 稳定认知放在职责边界与数据流上；工具参数、语言列表、默认超时属于易变细节。
>
> 源码基线：本仓库 `@code-yeongyu/pi-ast-grep`，包版本 `0.1.0`；工作区 HEAD `6f1c21c`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游独立仓库：[code-yeongyu/pi-ast-grep](https://github.com/code-yeongyu/pi-ast-grep)。底层引擎：[ast-grep](https://ast-grep.github.io)。

## 1. TLDR：它做的事情可以压缩成两条链路

`pi-ast-grep` 给 Pi 编码 Agent 增加两个工具：按**语法树**搜代码、按**语法树**改代码。匹配的是 AST 节点，不是正则、也不是纯文本。

```text
搜索：
模型调用 ast_grep_search
→ 扩展在当前 Pi 进程里拼出 sg 命令
→ 拉起外部 sg 子进程（找不到就按优先级找/下载）
→ 解析 JSON 命中
→ 截断、格式化、可能附带「你把 AST 写成了正则」的提示
→ 返回给模型；TUI 另读一份结构化 details

改写：
模型调用 ast_grep_replace（默认 dry-run）
→ 先跑一趟只出 JSON 的 sg（不写盘）
→ 若 dryRun=false 且确实有命中，再跑第二趟 sg --update-all
→ 把预览或已应用的命中列表交回模型
```

所以它不是：

- 不是内置 `grep` / `ffgrep` 的替代品（那两把刀搜文本；这把刀搜语法结构）
- 不是常驻的代码索引服务（没有 daemon、没有端口、没有后台 worker）
- 不是自己实现了一套解析器（真正干活的是外部 `sg` 二进制）
- 不是「注册成功就等于 sg 已就绪」（工具能出现在列表里，第一次调用才解析二进制）

正面定义：**它是寄生在 Pi 宿主进程里的扩展。判断搜什么、改不改，是模型的事；扩展只负责把 AST 模式翻译成 `sg` 子进程，并把结果收成模型能读的文本。**

权威数据源尽早钉死：磁盘上的源代码才是事实。`sg` 的 JSON 输出是一次调用的快照；扩展里的 `matches` 数组是这份快照的截断副本，不是索引。

## 2. 为什么不能只用 grep

普通 grep 按字节/正则找字符串。对 Agent 来说这经常「命中了但语义不对」：

| 你想做的事 | 用 grep | 用 ast-grep |
|---|---|---|
| 找出所有 `console.log(...)` 调用 | 会误伤注释、字符串、`console.log` 出现在类型声明里的情况 | 模式 `console.log($MSG)` 只匹配调用节点 |
| 把 `foo(x, y)` 改成 `foo(y, x)` | 正则很难保住任意参数表达式 | `$A, $B` 这类元变量按节点改写 |
| 跨 20 个文件做同一结构替换 | 多半要自己写脚本 | 一次 `ast_grep_replace`，默认先 dry-run |

正例：模式是一棵完整的 AST 碎片，例如 `function $NAME($$$) { $$$ }`。`$NAME` 捕获一个节点，`$$$` 捕获节点列表。

反例：把 `foo|bar`、`.*`、`\w` 丢进 `pattern`。这些是正则，不是 AST。扩展在「零命中且没有报错」时会尝试识别这类误用，并提示改用内置 grep，或改成 `$VAR` / `$$$`。

所以职责是这样切的：

- **模型**：决定搜哪个模式、哪个语言、要不要把 dry-run 改成真正写盘
- **扩展**：拼命令、找 `sg`、截断过大输出、把结果收成文本 + `details`
- **`sg` 二进制**：真正解析语言、匹配、改写
- **TUI 渲染**：只读 `details`，不解析那段给模型看的字符串

不要把「扩展注册了工具」理解成「扩展会自己判断该不该改代码」。写不写盘，由模型传入的 `dryRun` 决定，默认是预览。

## 3. 先看整体架构，不急着看类名

从上到下可以理解成五层。这是**职责图**，下一章再揭穿进程真相。

```text
┌─────────────────────────────────────────┐
│ 宿主层  Pi 进程                           │
│ 加载扩展、把工具暴露给模型、画 TUI         │
└───────────────────┬─────────────────────┘
                    │ 工具调用
┌───────────────────▼─────────────────────┐
│ 工具层  ast_grep_search / replace         │
│ 校验语言、补默认路径、决定 dry-run 还是写盘 │
└───────────────────┬─────────────────────┘
                    │ RunSgOptions
┌───────────────────▼─────────────────────┐
│ 适配层  cli + 二进制解析                   │
│ 拼 sg 参数、spawn 子进程、超时杀掉          │
└───────────────────┬─────────────────────┘
                    │ stdout JSON
┌───────────────────▼─────────────────────┐
│ 结果层  json-output + formatter + hints   │
│ 截断、抢救半截 JSON、空命中时给模式提示     │
└───────────────────┬─────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   模型可读文本              TUI details
```

每层「收到什么 → 做什么 → 产出什么」：

| 层 | 收到 | 做 | 产出 |
|---|---|---|---|
| 宿主 | 用户对话 / 模型的 tool call | 调度工具、画界面 | 一次 `execute` 调用 |
| 工具 | `pattern` / `lang` / `paths` / `dryRun` | 校验语言，默认路径用 `ctx.cwd` | `RunSgOptions` |
| 适配 | 选项 + 是否写盘 | 找 `sg`，必要时下载，spawn | stdout / stderr / exitCode |
| 结果 | 原始 JSON 文本 | 解析、截断、提示 | `SgResult` |
| 呈现 | `SgResult` | 两路输出互不解析对方 | 模型文本 + TUI `details` |

类名在这里不重要。真正的分层边界只有两道：

1. **扩展进程内的 TypeScript**（注册、拼参、解析）
2. **外部 `sg` 子进程**（解析语言、匹配、改文件）

`/ast-grep` 和 `/ast-grep install` 不走工具层，它们是给人看的命令：查缓存路径，或强制下载一份 `sg`。

## 4. 实际怎样运行：它是寄生扩展，没有自己的进程

它主要是一个 **Pi 扩展包**，不是 CLI 产品，也不是服务。

证据：

- `package.json` 里 `pi.extensions: ["./src/index.ts"]`，安装后由 Pi 发现并加载
- 入口默认导出一个函数，签名是 `function (pi: ExtensionAPI): void`
- 没有 `bin/`、没有 `serve`、没有 Dockerfile、没有 systemd 单元

装了什么、跑起来是什么：

```text
pi install npm:pi-ast-grep
  → 宿主下次启动时 import src/index.ts
  → 注册两个工具 + 一个 /ast-grep 命令
  → 扩展代码活在 Pi 进程里

第一次有人调用工具
  → 当前进程里解析 sg 路径
  → 找不到再考虑 GitHub 下载到缓存目录
  → spawn 一个短命的 sg 子进程
  → sg 退出，扩展继续
```

**没有常驻的 ast-grep 服务。** 「适配层」是代码职责，不等于一台持续监听端口的服务器。每次工具调用都在当前 Pi 进程里创建一次子进程，随这次调用结束而退出。用户不需要另外启动 X。

和宿主的边界：

```text
Pi 宿主进程
 ├─ 扩展模块（TypeScript，随宿主加载/退出）
 └─ sg 子进程（按次 spawn，超时 SIGTERM，1 秒后 SIGKILL）
```

被谁拉起的进程就归谁：Pi 拉起扩展代码；扩展拉起 `sg`。`sg` 崩溃不会拖垮 Pi，只会变成这次工具结果里的 `error` 字段。

二进制查找顺序（同步路径，第一次调用时走）：

1. 缓存：Unix `$XDG_CACHE_HOME/pi-ast-grep/bin/sg`，Windows `%LOCALAPPDATA%\pi-ast-grep\bin\sg.exe`
2. npm 包 `@ast-grep/cli` 目录里的 `sg`
3. 平台包（如 `@ast-grep/cli-darwin-arm64`）里的 `ast-grep` 二进制
4. `PATH` 上的 `sg`
5. macOS Homebrew：`/opt/homebrew/bin/sg`、`/usr/local/bin/sg`
6. 以上都没有：GitHub release 下载 zip 到缓存（`PI_OFFLINE=1` 时跳过）

校验方式很薄：存在、且文件大于 10 000 字节。热路径不跑 `sg --version`。

入口**没有**预热。源码里有 `startBackgroundInit()`，但 `src/index.ts` 不调用它。所以「扩展已加载」不能推导出「`sg` 已经在磁盘上」。

信任模型也要讲直：自动下载只走 HTTPS，**没有 checksum**。需要可复现来源时，手动安装 `sg` 并设 `PI_OFFLINE=1`。

## 5. 纵向链路一：一次 `ast_grep_search`

把一次真实搜索切成六层。整条链路同步发生在这一次工具调用里，没有后台任务。

```text
模型层 → 工具层 → 二进制层 → 子进程层 → 结果层 → 呈现层
```

### 5.1 模型层：收到「去找这种结构」→ 选出工具 → 产出一次 tool call

载体：Pi 宿主进程里的模型回合。同步。

模型填 `pattern`、`lang`（必填，25 种之一）、可选 `paths` / `globs` / `context`。扩展不替模型猜语言。

### 5.2 工具层：收到参数 → 校验并补默认路径 → 产出 `RunSgOptions`

载体：同一 Pi 进程。同步。

- `lang` 不在白名单 → 立刻返回错误文本，**不 spawn `sg`**
- `paths` 缺省 → `[ctx.cwd]`
- 搜索工具没有 `executionMode: "sequential"`，宿主允许它和别的只读工具并行

### 5.3 二进制层：收到「需要 sg」→ 按缓存到下载的顺序解析 → 产出可执行路径

载体：同一 Pi 进程。同步；下载发生时会打网络。

找不到且离线/下载失败 → 返回安装提示，仓库不变。这一步失败是整条链路最常见的基础设施错误，所以放在真正搜文件之前。

### 5.4 子进程层：收到 argv → `sg run -p ... --lang ... --json=compact` → 产出 stdout

载体：短命 `sg` 子进程。同步等待；默认超时 300 秒，超时先 SIGTERM，1 秒后 SIGKILL。

stdin 被忽略。扩展不把模式通过管道喂给 `sg`，而是放进 argv 的 `-p`。

「No files found」这类 stderr 会被收成空命中，而不是硬错误。有命中但 exitCode 非 0 且 stdout 有 JSON 时，仍尝试解析 stdout。

### 5.5 结果层：收到 JSON 文本 → 解析、截断、必要时给提示 → 产出 `SgResult`

载体：同一 Pi 进程。同步。

截断有三道闸，完成状态不等于「结果完整」：

| 闸 | 阈值（当前默认） | `truncatedReason` | 已有数据 |
|---|---|---|---|
| 输出体积 | 1 MB | `max_output_bytes` | 可能抢救到最后一个完整 `},` 对象；抢救失败则空命中 + error |
| 命中条数 | 500 | `max_matches` | 只留前 500 条，`totalMatches` 仍是截断前的长度 |
| 超时 | 300 s | `timeout` | 空命中 + error；不保证 `sg` 已把所有文件看完 |

空命中且没有 `error` 时，才跑模式提示（正则误用、Python 尾巴冒号、JS/Go/Rust 函数模式缺 body）。有 error 不加提示——先修基础设施。

### 5.6 呈现层：收到 `SgResult` → 两路输出 → 模型文本 + TUI

载体：同一 Pi 进程。同步。

给模型的是 `formatSearchResult` 拼出的字符串（`file:line:col` + 上下文行）。给 TUI 的是 typed `details`。渲染器约定：**不解析那段字符串**。改提示文案不会让 TUI 丢计数；改 `details` 形状才会。

**这条链路的完成语义：** 工具返回了，只证明这一次 `sg` 跑完（或超时被杀）并且扩展交出了文本。它不建立索引，下次同样的搜索会再跑一遍 `sg`。

## 6. 纵向链路二：一次 `ast_grep_replace`

改写默认是预览。真正写盘是第二趟子进程，而且可能失败在第一趟已经成功之后。

```text
模型层 → 工具层（dryRun 默认 true，且 sequential）
→ 第一趟 sg（只要 JSON，不 --update-all）
→ 若要落盘且有命中 → 第二趟 sg --update-all
→ 结果层（命中列表来自第一趟）
```

### 6.1 工具层多出来的约束

- `dryRun` 缺省当 `true`（实现是 `params.dryRun !== false`）
- `executionMode: "sequential"`：因为外部 `sg --update-all` 会改文件，不能和别的写工具抢
- `rewrite` 里可以用模式里的 `$VAR`

### 6.2 为什么拆成两趟

第一趟带 `--json=compact`、不带 `--update-all`，目的是拿到命中列表给模型和 TUI 看。第二趟才写盘。

理由：`sg` 一次同时 `--json` 和 `--update-all` 时，JSON 与写盘的耦合不好做「预览 / 应用」分叉。扩展选择先读后写。

### 6.3 同步阶段 / 写盘阶段

```text
同步预览（一定发生）：
  spawn sg → 解析 JSON → 得到 matches

写盘（仅 dryRun=false 且 matches.length > 0）：
  再 spawn sg --update-all
```

判定句：**第一趟 JSON 成功，只证明「按这个模式能匹配到这些位置」。文件是否已改，要看第二趟有没有跑、exitCode 是不是 0。**

第二趟失败时，返回值仍带着第一趟的 `matches`，再附 `error: "Replace failed: ..."`。此时模型可能看见「有 N 处替换」，但磁盘可能完全没动，或只动了一部分——扩展**没有**把多文件改写包在一个事务里。这是当前可靠性边界。

dry-run 文案会写 `Use dryRun=false to apply changes`。这是提示，不是第二道确认框；真正的闸是模型下一次调用时把 `dryRun` 设为 `false`。

超时、二进制缺失的失败形态与搜索链路相同：仓库不变。

## 7. 边界、误区与排错

### 7.1 概念区分

| | 文本搜索（grep） | AST 搜索（本扩展） |
|---|---|---|
| 匹配对象 | 字节 / 正则 | 语法节点 |
| 语言 | 可不声明 | 必须声明 `lang` |
| 空命中 | 多半是真没有 | 也可能是模式根本不是合法 AST |
| 并行 | 通常可以 | 搜索可以；替换强制顺序 |

| | 工具返回成功 | 文件已改 |
|---|---|---|
| search | 有文本结果 | 从不改 |
| replace + dry-run | 有预览 | 不改 |
| replace + 应用，第二趟失败 | 可能仍有 matches + error | **不要当成已改** |

### 7.2 常见误区

**「这是 ast-grep 的 Node API 封装。」错。** 正：它 spawn 官方 CLI。没有把 tree-sitter 链进这个 npm 包的运行时。

**「装上扩展，sg 就可用了。」错。** 正：注册发生在加载时；二进制解析发生在第一次工具调用（或你手动 `/ast-grep install`）。

**「零命中就是仓库里没有这种代码。」错。** 正：先看 `lang` 是否匹配文件、模式是否是完整节点、是不是把正则写进了 AST 模式。有 hint 时先信 hint。

**「替换工具返回了命中列表，文件就已经改了。」错。** 正：默认 dry-run。即便 `dryRun=false`，也要看有没有 `Replace failed`。

**「自动下载的 sg 和 npm 锁定的版本一定一致。」错。** 正：版本优先读 `@ast-grep/cli` 的 `package.json`，读不到就回落到写死的 `0.41.1`；下载物没有 checksum。

### 7.3 症状式排错

**工具在列表里，一调用就说 binary not found。** 先看 `PI_OFFLINE`、缓存目录是否可写、公司网是否拦 GitHub。不要先怀疑 pattern。`/ast-grep` 能打印缓存路径和 PATH 上的 `sg`。

**永远 No matches found。** 先核对 `lang` 与文件扩展名，再看模式是不是缺了函数参数/函数体。出现 Hint 时按 Hint 改，或改用 grep。不要先怀疑 `sg` 坏了。

**dry-run 能看到命中，apply 报 Replace failed。** 第一趟已成功，查第二趟权限、文件是否被锁、路径是否在沙箱外。不要先改 pattern。

**结果带 TRUNCATED。** 命中太多或 JSON 太大。收窄 `paths` / `globs`，或接受「这不是全量」。不要把前 500 条当成全部。

**TUI 计数和模型文本对不上。** 按约定应一致，因为它们来自同一份 `SgResult`。若不一致，查的是渲染是否误去解析字符串——那是回归，不是 `sg` 的问题。

## 8. 总结

可独立验证的稳定事实：

1. **它是 Pi 扩展，不是服务。** 代码活在宿主进程；`sg` 是按次拉起的子进程。
2. **权威内容是磁盘上的源码。** JSON 命中是一次调用的快照，且可能被截断。
3. **搜索与改写是两条可独立成败的链路。** 搜索成功不蕴含改写会成功；改写预览成功不蕴含文件已改。
4. **判断「搜什么 / 要不要写盘」的是模型。** 扩展管流程、截断和二进制，不管代码审查。
5. **当前没有包住多文件写盘的总事务。** 第二趟中途失败时，已写与未写没有回滚。

如果只记一条完整主线：

```text
Pi 加载扩展
→ 模型调用 ast_grep_search / ast_grep_replace
→ 扩展在本进程解析 sg（缓存 → npm → PATH → Homebrew → 下载）
→ spawn sg；搜索一趟 JSON，改写默认只预览，确认后第二趟 --update-all
→ 截断后的命中回到模型；TUI 读 details
→ sg 退出。没有索引，没有后台
```

## 9. 深入通道：按调用链读，不要按文件名散读

建议从运行入口往下。每个文件只回答一个问题。

1. `package.json` + `src/index.ts`：宿主怎么发现这个扩展？注册了哪些工具和命令？有没有预热二进制？（没有。）
2. `src/ast-grep/tools.ts`：两个工具的参数、默认路径、`dryRun`、为什么 replace 是 `sequential`。
3. `src/ast-grep/cli.ts`：argv 怎么拼、两趟写盘怎么分、找不到二进制时返回什么。
4. `src/ast-grep/binary-path.ts` + `downloader.ts` + `binary-downloader.ts`：查找顺序、`PI_OFFLINE`、下载有没有 checksum。
5. `src/ast-grep/json-output.ts` + `languages.ts`：1 MB / 500 条截断，半截 JSON 怎么抢救。
6. `src/ast-grep/result-formatter.ts` + `pattern-hints.ts`：模型看到的文本；空命中何时变成 Hint。
7. `src/ast-grep/process-timeout.ts`：300 秒之后进程怎么死。
8. `src/ast-grep/render.ts`：TUI 只消费 `details`。看完能懂「为什么改文案不必改渲染」。

测试是行为合同，不是附录。改查找顺序先看 `test/downloader.test.ts`、`test/node-portability.test.ts`；改两趟写盘先看 `test/cli-args.test.ts`、`test/sg-compact-json-output.test.ts`；真正拉 `sg` 的是 `test/sg-binary.integration.test.ts`（`npm run test:integration`）。

本地冒烟：`pi -e ./src/index.ts`，然后 `/ast-grep` 看路径，再让模型跑一次 `ast_grep_search`。

## 参考资料

- [pi-ast-grep README](https://github.com/code-yeongyu/pi-ast-grep)
- [ast-grep 官方文档](https://ast-grep.github.io)
- [oh-my-openagent 原工具位置说明](https://github.com/code-yeongyu/oh-my-openagent)（本包是 MIT 再授权的移植，omo 本身仍是 SUL-1.0）
- [pi-coding-agent 扩展 API 所在仓库](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
