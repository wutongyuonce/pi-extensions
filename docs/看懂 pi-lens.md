# 看懂 pi-lens：写完文件还不算完，诚实标签才算诊断

> 本文面向第一次接触 `pi-lens`、但已经知道「Pi 是编码 Agent、扩展会挂钩子和工具」的读者。仓库很大（约 1500 个 TS 文件），**不要从类名读起**。重点是：它解决什么问题、活在哪个进程里、一次 write 之后哪些分析已经完成、哪些还在路上、什么时候「没有发现」不等于「代码干净」。
>
> **本文定位：大仓库、二次开发深度，正文点到文件级。** 稳定认知放在职责边界、进程真相、freshness / 诚实标签上。工具名单、语言服务器列表、超时数字、MCP 工具个数都是易变细节。MCP 路径、`--lens-guard`、警告级 autofix 官方标成 **experimental**，不要当成生产主环。
>
> 源码基线：本仓库 `pi-lens`，包版本 `4.1.3`；工作区 HEAD `6f1c21c`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游：[apmantza/pi-lens](https://github.com/apmantza/pi-lens)。消费合同：[docs/agent-guide.md](../pi-lens/docs/agent-guide.md)。贡献合同：仓库内 `AGENTS.md`。

## 1. TLDR：它做的事情可以压缩成一条主环 + 一条拉取

pi-lens 给编码 Agent 做的是：**你每写/改一个文件，它就用语言相关的检查打你，并且拒绝把「沉默」说成「干净」。**

```text
主环（自动，寄生在 Pi 里）
  Agent write/edit
    → 磁盘已经变了
    → 进程内 pipeline：读盘 / 格式化 / autofix / 通知 LSP / 派发 linter
    → 这一文件的 blocker 进工具结果
    → 邻居影响、测试、项目级扫描……晚点（回合结束）才汇合
    → freshness 门卫决定能不能给模型看
    → 下一轮 context 注入，或等模型自己拉 lens_diagnostics

拉取（模型主动）
  lens_diagnostics / lsp_navigation / module_report / read_symbol
    → 先冲掉还在飞的 per-edit 任务
    → 再按门卫过滤缓存
    → 带诚实标签返回
```

所以它不是：

- **不是 IDE。** 没有编辑器界面；TUI 脚注只是给人看的计数，对模型不作数。
- **不是「又一个 linter」。** 它调度 LSP 子进程、一堆 CLI、ast-grep / tree-sitter、影响面级联，还管 read-before-edit。
- **不是** 替代 Pi 的 `read` / `grep`。结构化导航是漏斗，不是搜索引擎。
- **不是** 你自己的编译器。tsc / pyright / rust-analyzer 是它 **spawn 出来的孩子**。
- **不是** `systemctl start` 的 daemon。生产路径是 Pi 扩展，跟着 Pi 进程活。
- **不是** MCP 服务器。MCP 是同一套引擎的第二宿主，实验性，给 Claude Code 用。

正面定义：它是编码 Agent 的 **写时反馈环**——磁盘为事实，诊断为派生，门卫决定「此刻能不能当作证据」。

权威数据源（没有单一 SoT，问不同问题看不同地方）：

| 你在问 | 权威在哪 |
|---|---|
| 文件现在是什么字节 | **磁盘** |
| 类型检查器怎么想 | **LSP 子进程的内存**（didOpen/didChange 之后） |
| 能不能把这条发现给模型看 | **门卫之后的 findings**，不是原始 LSP 推送 |
| 项目级味道 / 图 | `.pi-lens/` 下带序号的快照；可能是 partial |

## 2. 为什么不能「写完再跑一次 eslint」

Agent 的回合很短，而且它会把「工具没骂我」理解成「完工」。普通 linter 有两个坑：

1. 跑慢了，Agent 已经开始改下一个文件。
2. 跑失败了或还是冷的，返回空列表——模型当成干净。

pi-lens 的架构判断是：**把反馈塞进 write/edit 的生命周期，并且给每条结果贴诚实标签。** `partial` / `stale` / `unconfirmed` / `cold` / `degraded` / `unavailable` 出现时，空结果不是清洁证明。

正反例：

| 该信 pi-lens | 不该信 |
|---|---|
| 工具结果里的 🔴 blocker，标签是完整扫描 | 脚注 widget 显示 0 error |
| `lens_diagnostics mode=full` 且没有 degraded 标签 | MCP `fresh` 冷启动 LSP 报了 `0` |
| 标签写 `stale`，叫你重扫 | 「这次 write 的工具结果已经返回，所以级联也结束了」 |

职责分工：

- **Pi 宿主**负责真的写盘、发 `tool_call` / `tool_result` / `turn_end`。
- **pi-lens 扩展**负责在这些事件上跑分析、贴标签、注入下一轮上下文。
- **LSP / CLI 孩子**负责语言事实（类型、lint、格式）。
- **模型**负责修；修之前必须尊重标签。判断「什么算完」的是模型，但「这次检查算不算数」的是门卫。

不要把「支持很多语言」理解成「每种语言一套算法」。语言是 runner 扩展轴；主环（事件 → pipeline → 门卫 → 投递）只有一条。

## 3. 先看整体架构，不急着看类名

文档视角（README 故事，先教这个）：

```text
Pi 宿主事件
  → 写时车道：pipeline → 派发计划 → runner + tree-sitter/ast-grep
  → LSP 车道：客户端池 → 文件/工作区诊断 → 影响级联
  → 守卫：读了再改、可选 git commit 拦截
  → 仓库：widget / 警告缓存 / 项目快照
  → 门卫：mtime、行号失效、import 漂移、处置
  → 投递：回合结束注入、工具拉取、脚注
```

门卫那一格**不是调用顺序**。一条发现只走对它适用的闸。把架构图当成流水线会读错。

进程真相：

```text
Pi 宿主进程（生产路径）
  ├─ index.ts          宿主适配：注册事件 / 工具 / 命令
  ├─ 进程内 runtime    会话记忆、pipeline、派发器
  ├─ LSP 子进程们      tsserver / pyright / rust-analyzer …
  ├─ CLI 子进程们      ruff / biome / eslint / clippy …
  └─ worker_threads    快照/图的 gzip，躲开事件循环

另一条可选进程（实验）
  MCP 客户端拉起 pi-lens-mcp（stdio JSON-RPC，长活）
    ├─ 同一套引擎
    ├─ warm：用启动时那份内存
    └─ fresh：再 fork 一个短命 Node，加载刚 build 的 dist
```

图纸和进程不一致的地方，就是精华：

1. **工具结果返回 ≠ 分析做完。** 影响级联是故意不 await 的，停在会话记忆里，回合结束再亮出来。测试也在 `turn_end`，不在每次 write。
2. **`write` 和 `edit` 的 autofix 时刻不同。** `write` 的确定性修复可以跟在本次工具结果里；`edit` 的格式化/autofix  defer 到 `agent_settled`。所以同一次 edit 的 lint 可能看到「还没 autofix 的磁盘」。
3. **生产宿主不经过「引擎门面」这一跳。** MCP 被要求只走内部缝 `clients/lens-engine.ts`；Pi 的 `index.ts` 仍然直接钩 runtime / pipeline。不要教「一切都经 LensEngine」。
4. **脚注 widget 不是权威。** 人看计数；模型看 `lens_diagnostics`。

## 4. 实际怎样运行：寄生扩展是主形态，孩子是 LSP 和 CLI

证据在 `package.json`：

- `pi.extensions`: `./dist/index.js` —— Pi 把扩展 **load 进自己的进程**。
- `bin`: `pi-lens` / `pi-lens-mcp` / `pi-lens-analyze` —— 这些不是扩展启动器。

谁拉起：Pi 加载扩展时。用户不必先开 pi-lens 服务。`--no-lens` 可以本会话关掉，再用 `/lens-toggle` 打开。

有没有常驻进程：

- **生产：** 没有独立 daemon。扩展随 Pi 活，随 Pi 死。没有自己的 supervisor。
- **LSP 孩子：** 有。空闲约 240 秒收掉；崩了会拉起来；短时间死太多次会进 `broken`，直到本次会话结束都不再试。
- **MCP：** 只有 MCP 客户端拉起时才有一条长活 Node。官方写明：**Pi 从不跑这个 server。**

崩溃语义：

| 层 | 谁管复活 |
|---|---|
| 扩展代码 | 不管。Pi 挂了就一起没 |
| LSP 子进程 | 扩展内重启；崩溃循环 → 本会话永久 disable |
| 孤儿 LSP | `~/.pi-lens/instances.json` 记录；父进程已死才杀孩子。心跳过期只清登记，不杀还活着的空闲会话 |
| MCP `fresh` worker | 跑完一条 JSON 就 `process.exit`（否则 LSP handle 会把事件循环挂住） |

和宿主的关系：

```text
用户的 Pi 进程 = 宿主
  pi-lens 扩展 = 寄生模块（同 pid）
  LSP/CLI = 孩子
  MCP = 另一个可选宿主进程，不是这条生产链的一环
```

配置叠层（高优先在上）：`PI_LENS_*` 环境变量 → CLI 旗标 → 项目 `.pi-lens.json` → `~/.pi-lens/config.json` → 内置默认。项目文件主要管 **要不要改你的文件**（format / autofix）；诊断默认仍会跑。

信任：不信任的项目不会自动装语言工具、不会随便 spawn LSP。这是安全边界，不是漏检 bug。

## 5. 三种入口差在哪（有对照才写）

| 入口 | 谁启动 | 活多久 | 一次分析看到什么 | 什么时候用 |
|---|---|---|---|---|
| Pi 扩展 | Pi | 跟会话 | per-edit 偏 delta + 行内 blocker；回合结束再汇合 | **生产** |
| `pi-lens-mcp` | MCP 客户端 | 长活 stdio | `warm` 看服务器启动时的代码像；`fresh` 看刚 build 的 dist | 给 Claude Code 做实验性审查环 |
| `pi-lens-analyze` | hook 短进程 | 一次 | 默认 **no-lsp**，求快；`--turn-end` 只能走 warm IPC | Claude Code PostToolUse / Stop；exit 0，不阻断编辑 |

`pi-lens` 这个 bin 目前只做 `build-graph`，不是「启动扩展」。

把 MCP 文档当现状清单会过时——`docs/mcp.md` 是工作笔记。当前工具面以 `mcp/server.ts` 和 `AGENTS.md` 的 MCP 节为准。

## 6. 纵向链路一：Agent 写了一个文件之后

切层连读：钩子层 → 磁盘层 → pipeline 层 → LSP 同步层 → 派发层 → 行内投递层 → （未完成）级联层 → 回合汇合层。

```text
tool_call → 磁盘变更 → tool_result/pipeline → LSP didChange → runners
  → 本文件 blocker 回工具结果
  → 级联/测试/格式化还在路上
  → turn_end / agent_settled 才汇合
```

### 6.1 钩子层：`tool_call` 先记「读没读过」

载体：Pi 进程。read-guard 在写入落地前记账。没读过、读完磁盘又变了、改的行不在读过的范围，编辑会被打回或警告。路径必须归一化（Windows 反斜杠 vs URI 斜杠是同一文件）——这是硬不变式，不是格式癖好。

### 6.2 磁盘层：Pi 自己的 write/edit 改字节

pi-lens 不代替写盘。**磁盘才是这次 mutation 的权威。** 分析全程要能重新读到 autofix 之后的字节。

### 6.3 pipeline 层：`tool_result` 里 await 的那一段

载体：Pi 进程。大致顺序：读文件 → 格式化（常常 defer）→ autofix（write 立即，edit 延后）→ 通知 LSP → 派发。

**这一层返回 ≠ 格式化已落盘。** 默认 format 是 deferred，排到 `agent_settled`。

### 6.4 LSP 同步层：didChange 发给孩子

载体：LSP 子进程。发出去 ≠ 诊断已经发表。空诊断更不等于干净——push-only 的服务器安静时，标签是 `unconfirmed`。

### 6.5 派发层：按文件种类跑一组 runner

载体：进程内编排 + CLI 孩子 + 进程内 ast-grep/tree-sitter。各 runner 有超时。超时记录在案，可以 collect-later，不会把半截结果标成完整。

### 6.6 行内投递层：本文件、本次 write 的 blocker

跟工具结果一起回去。邻居文件的影响不在这里。行为警告（瞎写、来回改）只在没有 blocker 时才露，以免把屏幕挤满。

### 6.7 级联层：不 await

针对「你改了 A，B/C 可能破了」。停在会话记忆，**回合结束**再亮。所以：**edit 的工具结果已经成功，只证明同步 pipeline 走完；邻居诊断就绪要看回合结束。**

### 6.8 回合汇合层：`agent_settled` + `turn_end`

- `agent_settled`：抽干延迟的 format/autofix。没有这个事件的宿主，不会得到一条悄悄的退路。
- `turn_end`：合并 blocker、测试、级联、部分项目级扫描；经 `context` 注入下一轮。注入是一次性消费，不反复刷。

INLINE 合同还规定：session_start 只给一条短通知；行内优先 blocker。这些是用户可见合同，不是内部优化。

## 7. 纵向链路二：模型自己来问「干净了没」

```text
调用 lens_diagnostics / lsp_* / module_report
  → 冲掉还在飞的 per-edit
  → 门卫过滤
  → 带标签的文本
```

永远亮着的工具少而硬：`lens_diagnostics`、`lsp_diagnostics`、`module_report`、`read_symbol` 等。其余（ast-grep 搜索替换之类）要先 `pi_lens_activate_tools`，**下一轮**才出现——当轮注册不等于当轮就能调。

`lens_diagnostics` 的 mode 不要混：

| mode | 人话 |
|---|---|
| delta / 默认缓存 | 这次会话积下来的警告 |
| all | 含 widget 那份更全的状态 |
| full | 贵，项目级 LSP 扫一遍 |

调用前会先等还没结束的 per-edit 派发。否则你看到的是 autofix 之前的世界。

`module_report` / `read_symbol` 是「先看大纲再读符号体」的漏斗，用来少读整文件。词索引 miss 会返回「没有」并在后台建；**没有 ≠ 文件是空的。**

导航类工具打到 LSP 孩子。服务器 cold / broken 时必须带 unavailable 类标签，禁止用空列表表示成功。

## 8. 门卫：完成状态不等于数据就绪

这是这个项目最值得单独成章的判断。

诊断从产生到能给模型看，至少过这些闸（不是固定流水，是按表面应用）：

- 文件还在不在、行号是不是已经 past-EOF
- mtime/size 之后必要时内容 hash（只信 mtime 会被 git checkout / 格式化骗到）
- 跨文件依赖：B 变了，A 上缓存的 blocker 不能接着用
- 处置（dispositions）：用户/规则说过「这条忽略」

教条是 **降级，不默默丢掉**。密钥类发现在文件变过之后变成「要处理但先不给行号」，而不是蒸发。past-EOF 是例外：降级投递一次，然后退休——行已经没了，模型再也确认不了。

诚实标签（消费侧硬规则）：

| 标签 | 含义 | 禁止 |
|---|---|---|
| unconfirmed | 空结果不能证明干净 | 说文件 clean |
| cold | 重型分析器没参加 | 把沉默算进「没问题」 |
| partial / truncated | 碰到文件上限 | 当成全项目覆盖 |
| stale | 缓存之后磁盘又变了 | 信旧行号 |
| degraded / unavailable | 这条通道坏了或跳过 | 当成功 |

**`--lens-guard`（实验、默认关）** 会在还有未解 blocker 时拦住 `git commit` / `git push`。模棱两可或过期的 blocker 宁可拦住。advisory 从不拦。

当前可靠性天花板：

- 没有包住 format + autofix + LSP + runner + 级联的总事务。
- 回合结束注入是「尽量一次」，不是分布式 exactly-once。
- 图持久化碰到上限可以是 **partial**。
- 同一 pid 里模块图可能被求值多次，进程级单例不是 `let` 顶层变量能表达的。并发 subagent 共用 LSP，守卫是 fail-safe，不是硬隔离。

## 9. 边界、误区

| 词 | 是 | 不是 |
|---|---|---|
| pipeline 完成 | 这次 write 的同步段走完 | 级联、测试、defer format 已就绪 |
| widget 0 | 给人看的脚注 | 清洁证明 |
| LensEngine | MCP 适配器的内部缝 | 生产 Pi 路径的唯一入口 |
| warm MCP | 长活进程里的热 LSP | 你刚 commit 的那份源码 |
| fresh MCP | 短命孩子加载新 dist | 更快的 warm |
| read-guard | 会话内「先读后改」 | 文件系统权限 |
| format.enabled: false | 不改你的文件 | 连诊断也不跑 |

常见误区：

- **错。** 沉默就是干净。**正。** 先看标签。
- **错。** pi-lens 就是那个 MCP server。**正。** 生产是 Pi 扩展。
- **错。** 它替换了 grep。**正。** 结构化工具是可选用的漏斗。
- **错。** write 返回时邻居文件的类型错误已经在结果里。**正。** 级联在回合结束。
- **错。** `agent_end` 会抽干格式化。**正。** 是 `agent_settled`。
- **错。** 在 `$HOME` 打开 Pi 还能当项目扫。**正。** unsafe root 会跳过扫描器。

## 10. 失败时先查哪条链路

**改了文件，工具结果里什么都没有，模型宣布完工。** 先看有没有诚实标签、lens 是否 `--no-lens`、是不是 edit 的诊断还在 defer。不要先重装语言服务器。

**有 blocker，修了依赖文件，本文件还报旧错。** 门卫的跨文件 freshness。拉一次 `lens_diagnostics mode=full`，不要信缓存行号。

**LSP 一直 unavailable / broken。** 孩子崩溃循环或没装。看 `/lens-health`。不信任的项目不会自动安装。不要把 broken 当成「零错误」。

**格式化突然改了 Agent 没碰的文件。** 查项目 `.pi-lens.json` 的 format/autofix；edit 路径的 mutation 发生在 settle，不在那次 tool 结果里。磁盘被外部改过会按 FileTime 跳过。

**MCP 审查环看着像旧代码。** 你在用 `warm`。要 `fresh` 或先 rebuild。这是诚实问题，不是缓存调优。

**Claude Code hook 从没类型错误。** `pi-lens-analyze` 默认 no-lsp。类型要走 warm 服务器。hook 还保证 exit 0——它不会帮你挡住那次编辑。

**home 目录下一片冷。** unsafe root。进项目再跑。

**子代理会话把主会话的 LSP 重置了。** 同进程多 session。扩展会尽量拒绝在主会话还活着时 reset；不确定就当成替换。这是已知天花板。

## 11. 如果只记一条主线

稳定事实：

1. 生产形态是 **Pi 进程内的扩展**，外加 LSP/CLI 孩子；不是独立 daemon。
2. **磁盘是 mutation 权威**；LSP 内存是类型权威；**门卫之后**才是给模型看的权威。
3. **工具结果返回 ≠ 分析结束**；级联、测试、defer format 更晚。
4. **沉默加 degraded 标签 ≠ 干净。**
5. MCP / git-guard / 警告 autofix 是实验支线，不是主环。

```text
Agent 写盘
  → 同进程 pipeline + 孩子 LSP/CLI
  → 本文件 blocker 立刻可见
  → 级联/测试/格式化稍后汇合
  → 门卫贴上诚实标签
  → 模型下一轮看到（或主动 lens_diagnostics）
  → 没标签的空结果，不准当完工
```

## 12. 想改代码时按这个顺序读

大仓库禁止按文件名散读。下面每组只回答一个问题：

1. `package.json` + `index.ts`（`export default` 和一串 `pi.on`）—— Pi 怎么挂上它，事件有哪些。
2. `docs/agent-guide.md` + `INLINE-CONTRACT.txt` + README 架构图 —— 消费合同：标签、blocker、模型不准下的结论。
3. `clients/runtime-tool-result.ts` → `clients/pipeline.ts` → `clients/runtime-agent-end.ts` —— 写路径里什么被 await、什么 defer。
4. `clients/dispatch/plan.ts` + `dispatcher.ts` + `runners/` —— 每种文件跑谁；CLI 孩子 vs 进程内。
5. `clients/lsp/index.ts` + `launch.ts` + `client.ts` + `wait-policy/` —— 池化、崩溃循环、空 ≠ 干净、空闲 240s。
6. `clients/runtime-coordinator.ts` + `runtime-turn.ts` + `runtime-context.ts` + `finding-delivery-gate.ts` + `freshness.ts` —— 会话记忆、回合汇合、「什么时候允许亮出来」。
7. 级联与 review-graph 构建入口（`computeCascadeForFile` 一带）—— 邻居为什么不在行内。
8. `tools/lens-diagnostics.ts` + `tools/module-report.ts` + `tools/activate-tools.ts` —— 模型真正拉取的 API；lazy 工具下一轮才出现。
9. `clients/lens-engine.ts` + `mcp/server.ts` + `mcp/analyze-cli.ts` + `mcp/worker.ts` —— 第二宿主；warm / fresh / hook；「Pi 从不跑它」。
10. `clients/lens-config.ts` + `docs/globalconfig.md` + `process-singletons.ts` + `instance-registry.ts` —— 配置叠层、同 pid 多份模块图、跨进程登记。

暂时不必读：每个语言一个的 `runners/*.ts`、`docs/mcp.md` 里的阶段故事、语言覆盖表。那些是叶子。

本地冒烟：在一个 TS 项目里 `pi install npm:pi-lens`，让模型改一个会类型错误的文件，看工具结果里的 blocker；再故意在标签是 `stale` 时问它「干净了吗」。模型如果回答干净，是消费合同被违反，不是分析器「没找到」。

## 参考资料

- [pi-lens README](https://github.com/apmantza/pi-lens)
- 仓库内 `docs/agent-guide.md`（模型消费合同）
- 仓库内 `docs/usage.md`（生命周期与 on-write 管道）
- 仓库内 `docs/globalconfig.md`（配置叠层）
- 仓库内 `AGENTS.md`（贡献合同与源码布局；按任务索引读，不要从头到尾）
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
