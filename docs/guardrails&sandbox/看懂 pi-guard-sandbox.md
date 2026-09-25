# 看懂 pi-guard-sandbox：把策略和隔离焊进一个 TUI 开关，而不是 npm 拼盘

> 本文面向已经读过（或准备对照）[`看懂 pi-sandbox.md`](./看懂%20pi-sandbox.md) 和 [`看懂 pi-guardrails.md`](./看懂%20pi-guardrails.md) 的读者。那两篇分别是「真正隔离」和「只是策略」。本篇讲第三层：**组合包怎样把两件事焊在同一个控制器里、焊的是想法不是那两个 npm 包、沙箱挂了会不会把命令漏到宿主机。**
>
> **本文定位：中小项目、二次开发深度。** 稳定认知放在「TUI-only、两套开关、fail-closed、!cmd 不护、不依赖另外两包」上。footer 文案、默认敏感路径、DCG 超时毫秒都是易变细节。
>
> 源码基线：本仓库 `guardrails&sandbox/pi-guard-sandbox/`，可运行的扩展在 `extensions/pi-guard/`，包 `pi-guard-sandbox` 版本 `0.3.0`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08）。该目录目前 **未纳入 git**。上游：[RunMintOn/pi-gaurd-sandbox](https://github.com/RunMintOn/pi-gaurd-sandbox)（仓库名少一个 d）。可选命令引擎：[Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard)，**不是 npm 依赖，要你自己装二进制**。

## 1. TLDR：焊的是两道闸，不是 `dependencies` 里的那两个包

打开组合包的 `extensions/pi-guard/package.json`：依赖是 `zod` / `commander` / `shell-quote` / SOCKS 库，**没有** `pi-sandbox`，**没有** `@aliou/pi-guardrails`。所谓「组合」是产品层把两道闸焊进一个 `/guard` 控制器：

```text
TUI 会话里的一次 Agent 工具调用

  闸 1  策略（JS，同步或 await 人）
        read/write/edit：敏感路径 / 保护路径 / 出仓库
        bash：built-in policy ID，或可选 DCG 短进程
        命中 block → 工具不执行

  闸 2  隔离（仅 bash，且闸 1 放行之后）
        prepareBash：SandboxManager.wrapWithSandbox
        再交给 Pi 的 local bash ops 去 spawn **已经包好的命令串**
        想要沙箱但沙箱没亮 → throw，不回落宿主机
```

所以它不是：

- **不是** `pi install` 另外两个包再写一层胶水。源码级零 import。
- **不是** 常驻 Guard 服务。没有独立进程盯着所有 shell。
- **不是** 非 TUI 方案。print / JSON / RPC 里它不注册、不 wrap、不拦。
- **不是** 把 `!cmd` / `!!cmd` 关进沙箱。状态文案写明了：只护 Agent 工具。
- **不是** pi-sandbox 的 fail-open 副本。沙箱依赖缺失时，本包 **拒绝 bash**，而不是 `localBash.execute`。

正面定义：一个 **仅 TUI** 的 Pi 扩展，用项目文件 `.pi/pi-guard.json` 当权威配置，把「路径/命令策略」和「vendor 的 OS sandbox-runtime」接到同一套运行时开关上。人可以单独关沙箱、单独关 DCG、或把整个 Guard 关掉。

`/guard sandbox off` 这一类命令改的是内存 `overrides`，**不写回 JSON**。下一个 Pi 进程 `refresh()` 会把 overrides 清掉，回到盘上的 `sandbox.enabled` / `mode` / `network`。测试里有明确断言：controller restores configuration defaults after runtime overrides。所以「我这次关过沙箱」≠「项目永远关了沙箱」。要永久改，编 `.pi/pi-guard.json`。

## 2. 为什么要焊，而不是「两个都装」

正例：只装 [`pi-guardrails`](./看懂%20pi-guardrails.md)。模型 `rm -rf src` 会被问一句；人点允许后，命令在宿主机删目录。策略完成了，隔离没发生。

反例：只装 [`pi-sandbox`](./看懂%20pi-sandbox.md)。bwrap 能挡住往家目录写，但初始化失败时 bash 会漏到宿主机；它也不解析「这是不是 curl|sh」。隔离有了，语义策略弱，失败语义还是 fail-open。

再反例：两个都装。两边都会动 bash：一个 hook 提问，一个替换工具再 wrap。加载顺序、双重提示、一边 fail-open 一边还以为有牢房——源码推得出这是糟的，本仓库没有「官方叠装合同」。

组合包的架构判断：

| 该焊在一个控制器里 | 不该假装已经 npm 组合 |
|---|---|
| 策略放行之后才 wrap | `import "pi-sandbox"` |
| 沙箱挂了 → 同一套 status 显示 `sandbox-unavailable` | 让两个页脚各说各的 |
| `/guard sandbox off` 明确把 bash 放回宿主机 | 初始化失败也静默放回宿主机 |
| DCG 当 **可选第三闸**，缺二进制就退回 built-in 正则 | 把 DCG 画成沙箱 |

职责分工：

- **闸 1（本包 JS）**：敏感读、保护写、出仓库批准、bashPolicy / DCG。
- **闸 2（vendor SandboxManager）**：内核级 FS/网络。跑在宿主里，wrap 在子进程上。
- **人**：`/guard` 开关、批准提示。Agent 不能给自己签发 bypass。
- **DCG（可选外部二进制）**：只对 Agent 的 `bash` 工具做命令语义。它不是隔离。

## 3. 先看整体架构，不急着看类名

文档视角：

```text
接入层     仅 ctx.mode === "tui"
           /guard status|init|on|off|sandbox on|off|dcg on|off|read-only|…
   ↓
配置层     .pi/pi-guard.json（缺了 kind=missing；坏了 kind=invalid）
   ↓
控制器     一份内存 state + 会话级 overrides（不写回 JSON，除非 init）
   ↓
闸 1 策略  tool_call → handleToolCall
   ↓
闸 2 隔离  被替换的 bash.execute → prepareBash → wrap 或 local 或 throw
   ↓
回收       session_shutdown → sandbox.reset()
```

进程真相：控制器、策略、vendor runtime 全在 **Pi 宿主进程**。闸 2 每次命令 spawn 一个被 bwrap 包住的子进程；会话期 runtime 可能再拉代理子进程。DCG 是 **每条命令一次** 的短进程（`dcg --robot test`），超时约 1 秒，不是常驻。

| 节点 | 载体 | 同步？ | 完成 ≠ 就绪 |
|---|---|---|---|
| 注册 | `session_start` 且 TUI | await 创建 adapter | 扩展已装 ≠ 非 TUI 会话被保护 |
| 配置 | 读 `.pi/pi-guard.json` | await | 文件存在 ≠ `kind === "valid"` 且 sandbox 已 apply |
| 策略 | `tool_call` | 可能 await 批准 | 批准这次 ≠ 下次换一种写法还通过 |
| wrap | `prepareBash` | await `wrapWithSandbox` | wrap 返回字符串 ≠ 子进程已按新 mask 启动 |
| DCG | spawn 短进程 | await，有超时 | `dcg --version` 成功 ≠ 这次 `test` 没超时 |
| 关沙箱 | `/guard sandbox off` | 同步改 override | footer 变成 `sandbox-off` = 之后 bash 在宿主机，**策略仍在** |

文档视角说「lightweight OS-level guard」。进程真相是：**TUI 里两道闸；非 TUI 零闸；用户手打的 shell 零闸。**

## 4. 运行形态：TUI 插件 + 可选外部二进制

入口 `extensions/pi-guard/index.ts` 把四件东西注入 `registerPiGuard`：sandbox adapter、local bash ops、createBashTool、DCG client。真正注册发生在 `session_start`：

- `ctx.mode !== "tui"` → 整个函数 return。测试 `non-TUI modes do not initialize sandbox, DCG, tools, status, or blocking` 锁死这件事。
- TUI 里替换 bash，label `bash (guarded)`。`exec` 先 `prepareBash`，再调用 **同一个** `localOps.exec`，差别只是命令串是不是已经 wrap、环境是不是改过 `TMPDIR` 等。

没有：

- 没有 Guard daemon。
- 没有跨会话的沙箱池。
- 没有在 print 模式下的静默保护（官方选择是「非 TUI 完全不工作」，不是「非 TUI 全 block」）。

有：

- 项目权威文件 `.pi/pi-guard.json`。
- 页脚 `[Guard: …]`。
- 可选 `dcg` 二进制，`DCG_BIN` 可改路径。

和另外两包的运行形态再钉一次：

| | pi-sandbox | pi-guardrails | pi-guard-sandbox（本篇） |
|---|---|---|---|
| 谁拉起 | 任意 session_start | 任意 session_start | **仅 TUI session_start** |
| 常驻 | 无 | 无 | 无 |
| bash 工具 | 替换，失败回宿主机 | 不替换 | 替换，失败 throw |
| 用户 !cmd | wrap | 不拦 | 不拦、不 wrap |
| 配置文件 | `.pi/sandbox.json` + 全局 | settings 三层 | **只有** `.pi/pi-guard.json` |
| 平台叙事 | macOS + Linux | 纯 JS | 文档按 Linux/WSL + `bwrap`/`socat`/`rg` 写 |

vendor 目录里确实有 `macos-sandbox-utils.js`。那是 runtime 家族自带的，不代表本包把 macOS 当成已验收产品面。以 README / 测试清单为准：缺 `bwrap` 就 `sandbox-unavailable`。

## 5. 三包对照：本篇只拥有「焊点 / 失败语义」这一列

| 问题 | pi-sandbox | pi-guardrails | 本包怎么焊 |
|---|---|---|---|
| 隔离实现 | `@carderne/sandbox-runtime` | 无 | **vendor 进仓库的 sandbox-runtime**，同家族不是同依赖 |
| 策略实现 | 路径/域名提示 | glob + AST + 四扩展 | **重写**：path-utils + bashPolicy ID + 可选 DCG |
| 两闸关系 | 文件策略和 bash wrap 在同一扩展，失败时 wrap 消失策略也消失 | 只有闸 1 | 控制器里 **可独立开关**：`guard` vs `sandbox` vs `dcg` |
| 沙箱 init 失败 | bash → 宿主机 | — | bash → **block / throw** |
| 人主动关沙箱 | Alt+S，策略钩子一并停 | — | `/guard sandbox off`：**闸 2 关，闸 1 仍在** |
| 人关掉全部 | config.enabled / --no-sandbox | `enabled: false` | `/guard off`，footer `Guard: OFF` |
| 文件工具 | JS 策略 | JS 策略 | JS 策略（永远不进 bwrap） |
| 命令语义 | 无 | AST | 正则 ID，或 DCG JSON decision |

焊的具体动作（对应源码，不是营销）：

1. **同一 `handleToolCall`** 先处理 bash 的 sandbox-unavailable（直接 block），再决定走 DCG 还是 `evaluateToolCall`。
2. **同一 `prepareBash`** 看 `effective().guard` 和 `effective().sandbox`：都开且 `sandboxActive` 才 wrap；想开沙箱但没 active 就 throw；人关了沙箱则 `{mode:"local"}`。
3. **同一 footer** 把 `sandbox-off` / `sandbox-unavailable` / `DCG:error` / `built-in` 显示成一种状态，避免两个扩展各说各的。
4. **敏感路径双写**：策略层 `sensitiveReadDeny` 拦 read 工具；隔离层 `injectMaskArgs` 给 bwrap 加 `--tmpfs` / `--ro-bind /dev/null`。一边漏了还有另一边——这才叫焊，而不是「两个产品碰巧都配置了 `~/.ssh`」。

## 6. 纵向链路 A：一条 Agent bash

1. **模式闸**（同步）  
   非 TUI：本包不存在，Pi 默认 bash 在宿主机跑。完成这步判断 = 后面所有焊点都没挂上。

2. **策略闸**（`tool_call`，可能 await）  
   - 整个 Guard off → allow。  
   - 要沙箱但 kind 是 `sandbox-unavailable` → **block**，理由 `Guard bash sandbox is unavailable.`  
   - DCG 可用且启用：`dcg --robot test`。`allow` 放行；`deny` / `indeterminate` / `error` 走 `onDeny` / `onIndeterminate` / `onError`（默认 confirm / notify / notify）。  
   - 否则 `classifyBashCommand`：`directBlock` 立刻拒绝，`requireApproval` 问人。  
   完成 DCG 调用 ≠ 可以改走 built-in 正则。README 写明：畸形 / 超时 / 失败 **不会** 对同一条命令 fallback 到 built-in，只执行 `onError`。默认 `onError: notify` 等于 **策略层 fail-open**（通知后放行），但闸 2 若仍开着，命令还是被 wrap。

3. **隔离闸**（`prepareBash`）  
   - Guard 关或 sandbox 关 → `{mode:"local", command}`，`localOps.exec` 原样命令。**这是漏到宿主机的正门**，是人下的令。  
   - 否则 `sandboxActive` 必须为真，不然 throw（测试：`socat missing`）。  
   - wrap 成功则带上 mask 路径和一份改过的 env（`TMPDIR=/tmp` 等）。  
   完成 wrap ≠ 敏感文件对子进程不可见：mask 只覆盖 `sensitiveReadDeny` 里能 stat 到的路径。

4. **spawn**（Pi 的 local bash ops）  
   跑的是字符串「已经被 bwrap 包住的命令」。隔离发生在这一步的子进程，不是发生在 Node 里。

5. **回收**  
   会话结束 `reset`。单条命令不拆掉整个 runtime。

完成 ≠ 就绪：`/guard init` 写出 JSON，只解决 `kind=missing`。要等 `refresh` 里 `sandbox.apply` 成功，footer 才不是 `uninitialized` / `sandbox-unavailable`。文件在 ≠ 牢房在。

## 7. 纵向链路 B：read / write / edit

这些工具 **始终在宿主 Node 里 I/O**，和另外两包一样。组合包多做的是「策略更像产品配置」而不是「突然有了 OS 隔离」。

1. Guard off → 全放行。
2. 路径解析失败 → block（解析不了就不让碰）。
3. `sensitiveReadDeny`：read 直接拒绝；对 bash 则另走 mask。
4. `protectedPaths.block`：write/edit 硬拒绝（默认 `.git`、`node_modules`）。
5. `protectedPaths.approval`：问人（默认 `.env`、`.pi/pi-guard.json`）。没 UI → block。
6. 出工作区的 write/edit：问人。没 UI → block。
7. 工作区内普通写：mode=`readonly` 时只许 `/tmp` 一类；`workspace-write` 才许仓库。

readonly 对文件工具是策略拒绝；对 bash 是 sandbox profile 的 `allowWrite: ["/tmp"]`。两闸又焊了一次：模型不能靠「换工具」躲开 readonly——换 bash 会碰到更瘦的 OS 可写集，换 write 会碰到 JS block。

`network: "blocked"` 同样只进 sandbox profile 的 `allowedDomains: []`，不进文件工具。Pi 自己谈模型仍可以出站。`network on/off` 也是会话 override，重启回 JSON。

`injectMaskArgs` 是焊点里最小、最实的一刀：在已 wrap 的 bwrap 命令串里找最后一个 ` -- `，把敏感目录放 `--tmpfs`、敏感文件放 `--ro-bind /dev/null`。stat 不到的路径不 mask——文件还不存在时，策略层的 `sensitiveReadDeny` 仍可以拦 `read` 工具。

## 8. 可选第三闸：DCG

DCG 是外部命令语义引擎，不是本包的隔离层。控制器对它的态度：

- `detect()`：`--version`。`ENOENT` → 静默用 built-in。超时/信号/`code!==0` → `DCG:error`，按 `onError` 处理。
- `evaluate()`：`--robot test <command>`，stdout 必须是 JSON，`decision ∈ {allow,deny,indeterminate}`，且和 exit code 一致（allow=0，其它=1）。
- 人用 `/guard dcg off` 可在本会话退回 built-in，不改 JSON。
- 默认 `dcg.enabled: true` 只表示「有二进制就用」，不是「没有二进制就失败」。

和 pi-guardrails 的 AST 门对比：那边内嵌 `@aliou/sh`，没有外部进程；这边可以把语义判断外包，但外包失败的默认动作是 notify 后继续——**语义闸 fail-open，隔离闸仍按 sandbox 开关走。**

## 9. 失败时命令会不会漏到宿主机

分门，不要混成一句「组合包更安全」。

| 触发 | bash | 文件工具 |
|---|---|---|
| 非 TUI | 宿主机（本包没挂） | 宿主机 |
| 用户 `!cmd` | 宿主机 | — |
| 配置 missing / invalid | 策略会按 kind 收紧；想要沙箱时 apply 不会成功 | 按 `evaluateToolCall` 的 statusKind |
| sandbox 依赖缺失（bwrap/socat） | **block / prepareBash throw** | 策略仍在 |
| `/guard sandbox off` | **宿主机**（正门） | 策略仍在 |
| `/guard off` | 宿主机 | 放行 |
| DCG 超时且 `onError=notify` | 策略放行，**若沙箱仍开则仍 wrap** | — |
| DCG 超时且 `onError=block` | 拦住，不会执行 | — |
| wrap 之后命令在沙箱里挂掉 | 失败在笼子里，不重跑宿主机 | — |

对照 pi-sandbox：那边没有「sandbox-unavailable 仍挡住 bash」的状态机，只有 `sandboxEnabled=false` 然后 `localBash.execute`。本包把「坏了」和「人关了」拆开：坏了不漏，关了才漏。

## 10. 边界、误区、排错

误区：

- **「安装组合包 = 安装了另外两个包的并集。」** 不是。规则语言、失败语义、TUI-only、!cmd 范围都不一样。
- **「footer 有 Guard 就是非 TUI 也安全。」** 非 TUI 不注册。
- **「sandbox-unavailable 和 sandbox-off 一样。」** 前者拒绝 bash，后者放回宿主机。
- **「DCG 在就是沙箱。」** DCG 不 wrap。关沙箱只留 DCG，命令仍在宿主机，只是多一次语义审查。
- **「readonly 会让 read 工具也进 bwrap。」** 文件工具从不进。
- **「敏感路径只靠 JSON 列表。」** bash 侧还靠 wrap 时注入的 mask；列表改了要 `refresh` 才能进下一次 wrap。

排错：

| 现象 | 先看 |
|---|---|
| 非交互脚本里 Guard 完全没反应 | 运行形态：不是 bug，是 TUI-only |
| footer `sandbox-unavailable`，bash 全失败 | 闸 2 缺依赖。不要把它当成「已经回宿主机了」 |
| footer `sandbox-off`，`rm` 能删仓库 | 人关的闸 2；看闸 1 的 bashPolicy 还在不在 |
| DCG:error 但仍执行 | 默认 `onError=notify`。改 `block` 才会停 |
| `!cmd` 碰 `~/.ssh` 成功 | 范围外。要护手打命令，去看 pi-sandbox 的 `user_bash`，本包不做 |
| 和 pi-sandbox 叠装 | 两个都替换 bash。拆掉一个 |

本地冒烟：TUI 里 `pi install` 本包，`/guard init`，看 footer 不是 `uninitialized`；让模型 `echo hi`（应成功且在沙箱）；让模型 `read ~/.ssh/id_rsa`（应被敏感路径拦）；`/guard sandbox off` 后再让模型跑一条出仓库的 bash，策略可能还问，但 OS 笼子已撤——用这个确认「正门漏宿主机」的形状。最后在 `pi --print` 一类非 TUI 下重复，确认整包没挂上。

## 11. 总结

可独立验证的稳定事实：

1. 本包 **不依赖** pi-sandbox / pi-guardrails。焊的是两道闸和一个 `/guard` 状态机。
2. 只在 TUI 注册。非 TUI 和用户 `!cmd` 等于没装。
3. 文件工具永远是策略；bash 在闸 1 放行后才 OS wrap。
4. 沙箱 **不可用** 时 bash 被拦住；沙箱被 **人关掉** 时 bash 回宿主机，策略仍可在。
5. DCG 是可选短进程，默认错误动作是 notify；它不能代替闸 2。

主线：

```text
TUI 里 Agent 要动手
  → 策略闸（路径 / bashPolicy / 可选 DCG）
  → bash 再进 vendor OS wrap；文件 I/O 留在宿主 Node
  → 沙箱坏了：命令停在门外
  → 沙箱被关掉 / 非 TUI / !cmd：命令在宿主机
```

## 12. 源码阅读顺序

1. `extensions/pi-guard/package.json` + 根目录 README 第 6 节 — 先看它 **没** 依赖另外两包，以及 TUI-only / !cmd 声明。
2. `extensions/pi-guard/index.ts` — 注入点：sandbox / localOps / bash 工具 / DCG。
3. `src/extension.mjs` 的 `session_start` 和 `guardedOps.exec` — 看了能懂焊点：先 prepare 再 local spawn；非 TUI 直接 return。
4. `src/guard.mjs` 的 `refresh` / `handleToolCall` / `prepareBash` / `formatGuardFooter` — 状态机。看了能懂 `sandbox-unavailable` vs `sandbox-off`。
5. `src/runtime-sandbox.mjs` — adapter：依赖检查失败 throw；wrap 后可 `injectMaskArgs`。
6. `src/tool-policy.mjs` + `src/bash-policy.mjs` — 闸 1 的 JS 合同；policy ID 不是裸正则。
7. `src/sandbox-config.mjs` + `src/constants.mjs` — JSON 怎么变成 runtime profile；readonly 的 allowWrite 为什么只剩 `/tmp`。
8. `src/dcg.mjs` — 短进程协议、超时、error 不落到 built-in。
9. `test/extension.test.mjs` + `test/bash-policy.test.mjs` 里 sandbox-unavailable 那则 + `test/runtime-sandbox.test.mjs` — 行为合同。

暂时不必读：`vendor/sandbox-runtime/**` 的 seccomp / proxy 实现（当黑盒 wrap）、`.scratch` 里的 issue 流水、红队提示词。

二次开发优先碰的缝：任何新的「失败回宿主机」都要先问，这是不是用户正门（`sandbox off` / `guard off`）。若不是，就应该走 `sandbox-unavailable` 那条 throw/block，不要抄 pi-sandbox 的 `localBash.execute`。
