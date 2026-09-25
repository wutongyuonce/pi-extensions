# 看懂 pi-sandbox：真正把 bash 关进 OS 沙箱的那一层

> 本文面向已经知道「Pi 是编码 Agent、扩展会挂钩子和工具」的读者。同目录还有 [`看懂 pi-guardrails.md`](./看懂%20pi-guardrails.md)（纯策略）和 [`看懂 pi-guard-sandbox.md`](./看懂%20pi-guard-sandbox.md)（把策略和隔离焊在一起的组合包）。三篇必须对照着读：本篇只讲 **谁真正起隔离**。
>
> **本文定位：小项目、二次开发深度。** 稳定认知放在「bash 进 OS 沙箱 / 文件工具仍是 JS 策略 / 初始化失败会漏到宿主机」三条边界上。域名白名单、提示超时秒数、默认路径列表都是易变细节。
>
> 源码基线：本仓库 `guardrails&sandbox/pi-sandbox/`，包 `pi-sandbox` 版本 `0.6.5`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08）。该目录目前 **未纳入 git**，没有目录级提交可写。上游：[carderne/pi-sandbox](https://github.com/carderne/pi-sandbox)。OS 运行时：[npm:@carderne/sandbox-runtime](https://www.npmjs.com/package/@carderne/sandbox-runtime)（源自 Anthropic 的 sandbox-runtime 家族）。祖先实现：[badlogic/pi-mono 的 sandbox 示例](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)。

## 1. TLDR：它不是「把 Pi 整个关进虚拟机」

一次 Agent 动作在这个包里走两条完全不同的路：

```text
bash / 用户 !cmd
  宿主 Node 里的扩展 → SandboxManager.wrapWithSandbox
  → 子进程被 sandbox-exec（macOS）或 bubblewrap（Linux）包住
  → 文件系统 + 网络由内核/seatbelt 执行，不是字符串匹配

read / write / edit
  仍在 Pi 的 Node 进程里直接做 I/O
  → 扩展只在 tool_call 上做 allow/deny/prompt
  → OS 沙箱覆盖不到这条路（工具根本没进子进程）
```

所以它不是：

- **不是** 容器 / 虚拟机 / 常驻 sandbox daemon。没有独立服务进程等你连。
- **不是** 文件工具的 OS 隔离。README 自己写了：这些工具跑在 Node 里，沙箱包不住。
- **不是** 失败即拒绝。初始化失败、`--no-sandbox`、配置 `enabled: false`、Alt+S 关掉之后，bash **会回到宿主机直跑**。
- **不是** [`pi-guardrails`](./看懂%20pi-guardrails.md)。那边从不 wrap 命令。
- **不是** [`pi-guard-sandbox`](./看懂%20pi-guard-sandbox.md)。组合包 vendor 了同类运行时，但 **没有 npm 依赖本包**，失败语义也相反（那边 fail-closed）。

正面定义：它是挂在 Pi 会话上的 **bash OS 沙箱 + 文件工具策略提示**。权威数据源是两份 JSON：项目 `.pi/sandbox.json` 和全局 `getAgentDir()/sandbox.json`（默认 `~/.pi/agent/sandbox.json`，尊重 `PI_CODING_AGENT_DIR`）。会话期临时放行只活在内存，Agent 读不到。

## 2. 为什么文件工具不能「顺便」进沙箱

正例：模型说 `cat /etc/passwd`，走 bash。扩展把命令交给 `SandboxManager`，内核按 seatbelt/bwrap 的只读/可写集合执行。写到 `denyWrite` 里的路径，子进程会拿到 `Operation not permitted`。

反例：模型调 `read` 去读 `~/.ssh/id_rsa`。`read` 是 Pi 内置工具，在 **同一个 Node 进程**里 `fs.readFile`。没有任何 bwrap 包住它。本包只能在 `tool_call` 钩子里对照 `allowRead` / `allowWrite`，提示或拦截。钩子没挂上、沙箱已 disable、或者路径被用户点了 Allow，文件就在宿主机上被读走。

这是架构判断，不是偷懒：

| 该靠 OS 沙箱 | 不该指望 OS 沙箱 |
|---|---|
| Agent / 用户打出来的 shell 命令 | `read` / `write` / `edit` |
| 命令里的网络（域名走代理） | Pi 自己的模型 API 流量（不经过这条 wrap） |
| bash 写文件失败后的「再问一次」 | 已经在 `denyWrite` 里的路径（硬拒绝，不问） |

职责分工：

- **内核 / sandbox-exec / bwrap**：真正隔离 bash 子进程的 FS 和网络。
- **`@carderne/sandbox-runtime` 的 SandboxManager**：在宿主进程里拼 wrap 命令、拉起 HTTP/SOCKS 代理、会话结束 `reset`。
- **本扩展的 JS 策略**：文件工具的 allow/deny/prompt；bash 被挡写时解析 stderr 再问一次。
- **人**：点 Abort / 本会话 / 本项目 / 全局。超时默认选 Abort，**超时绝不放行**。

## 3. 先看整体架构，不急着看类名

文档视角（扩展对外承诺的职责）：

```text
接入层     --no-sandbox / Alt+S / /sandbox* 命令 / 页脚锁形状态
   ↓
配置层     内置默认 ⊕ 全局 sandbox.json ⊕ 项目 .pi/sandbox.json ⊕ 内存 session allowances
   ↓
策略层     域名 / 读路径 / 写路径（JS，同步判断；需要人时才 await 提示）
   ↓
隔离层     仅 bash：wrap → 沙箱子进程；文件工具到此结束，不进这一层
   ↓
回收层     session_shutdown → SandboxManager.reset()
```

进程真相：上面五层都在 **Pi 宿主进程**里。SandboxManager 的注释写得很干脆——它跑在沙箱 **外面**、宿主机上。会话期间它可能再拉 HTTP 代理、SOCKS 代理这类 **子进程**，用来给被 wrap 的 bash 做域名过滤；这些子进程跟着会话走，不是独立 daemon，也不是「沙箱服务」。

| 节点 | 载体 | 同步？ | 完成 ≠ 就绪 |
|---|---|---|---|
| 配置加载 | 宿主进程读两个 JSON | 同步 | 文件在磁盘上 ≠ 本会话 allowances 已含这条路径 |
| 文件工具拦截 | `pi.on("tool_call")` | 需要提示时 await UI | 钩子返回 ≠ 磁盘已改；返回 `{block}` 才没改 |
| bash wrap | 每次 `execute` 现包一条命令 | 同步 spawn，等待子进程 | wrap 成功 ≠ 命令在策略上被允许（域名/写路径另判） |
| 网络代理 | SandboxManager 会话级子进程 | 初始化时拉起 | `initialize()` resolve ≠ 某个域名已在白名单 |
| 关掉沙箱 | `SandboxManager.reset()` + 回退 `localBash.execute` | 同步 | 页脚锁消失 = 之后的 bash 在宿主机上跑 |

文档视角说「sandbox for pi」。进程真相是：**只有 bash 子进程进沙箱；Pi 本体、文件工具、模型调用都在宿主机。**

## 4. 运行形态：插件，不是服务

它是一个 `pi.extensions: ["./index.ts"]` 的 Pi 扩展。`index.ts` 只 re-export `src/extension.ts` 的 default。Pi 启动加载它，会话开始尝试 `enableSandbox`，会话结束 `reset`。

没有：

- 没有监听端口的 sandbox server。
- 没有开机自启的守护进程。
- 没有跨 Pi 进程共享的沙箱池。

有：

- 会话内的 SandboxManager 单例（在宿主里）。
- 可选的代理子进程（给被隔离的 bash 用）。
- 一条被替换的 bash 工具，label 是 `bash (sandboxed)`。关掉或没初始化成功时，**同一个工具对象**会调用原先的 `localBash.execute`。

和另外两包的运行形态对照：

| | pi-sandbox（本篇） | pi-guardrails | pi-guard-sandbox |
|---|---|---|---|
| 活在哪个进程 | Pi 宿主 | Pi 宿主 | Pi 宿主，且 **只在 TUI** |
| 常驻？ | 否 | 否 | 否 |
| 谁拉起 | `session_start` → `enableSandbox` | `session_start` 发 feature 事件 | `session_start` 且 `mode === "tui"` |
| bash 真正隔离？ | 是（OS wrap） | 否 | 是（vendor 的同类 runtime） |
| 文件工具隔离？ | 否，只有策略 | 否，只有策略 | 否，只有策略 |
| 失败时 bash 去哪 | **宿主机**（fail-open） | 本来就在宿主机 | **拦住**（fail-closed），除非用户主动 `/guard sandbox off` |

macOS 默认打开 `allowUnauthenticatedSocksProxy`，好让 Git-over-SSH 走内置 `nc`。域名过滤仍在，但本机另一个进程如果发现了临时代理端口，可以在沙箱会话期间蹭用。这是 README 标过的洞，不是隐藏行为。

## 5. 三包对照：本篇只拥有「隔离」这一列

后两篇会从策略覆盖面、焊接方式再画一张表。这里只钉死 **隔离 vs 策略 vs 失败**：

| 问题 | pi-sandbox | pi-guardrails | pi-guard-sandbox |
|---|---|---|---|
| 谁真正隔离 | `@carderne/sandbox-runtime` wrap bash | 没有隔离层 | vendor/`sandbox-runtime` wrap bash |
| 谁只是策略 | 文件工具 + 域名提示 | **整个包** | 路径 / bashPolicy / DCG |
| 是不是另外两包的依赖组合 | — | README 把本包列为「相关沙箱」，并不 import | **不 import 本包，也不 import guardrails** |
| 用户 `!cmd` | `user_bash` 钩子会 wrap | permission-gate 只看 Agent `bash` 工具 | **明确不护** |
| 初始化失败 | 通知一声，bash 回宿主机 | 无沙箱可失败 | `sandbox-unavailable`，bash 被 block |
| 平台 | macOS `sandbox-exec` + Linux `bwrap` | 纯 JS，跟 OS 无关 | 文档写 Linux/WSL；macOS 未测 |

读本篇时记住一句话：本包的独特资产是 **失败也会漏到宿主机的那层 OS wrap**。组合包抄了 wrap、改了失败语义；guardrails 连 wrap 都没有。

## 6. 纵向链路 A：一条 Agent bash 怎么进沙箱

语义层（5–7 层就够，不按函数切）：

1. **宿主接入**（Pi 进程，同步）  
   模型发出 `bash` 工具调用。本包在 `session_start` 时用 `pi.registerTool` 换掉了内置 bash。

2. **开关闸**（内存标志，同步）  
   `sandboxEnabled && sandboxInitialized` 为假 → 直接 `localBash.execute`。**完成这条判断 = 命令已经决定在宿主机跑**，后面的 wrap 不会发生。

3. **策略闸**（JS，可能 await UI）  
   `tool_call` 里扫命令字符串里的 `https://...` 域名。不在 `allowedDomains`（加 session 域名）就弹窗。人选 Abort 则 `{block:true}`，命令不会 spawn。  
   完成提示 ≠ 域名已写进 JSON：选「本会话」只改内存。

4. **隔离包装**（宿主进程调 SandboxManager，同步拼命令）  
   `createSandboxedBashOps().exec` 用用户 shell 跑 **已经被 wrap 的命令串**。`sshProxy` 默认开：给普通 `ssh` 塞一个走 SOCKS 的 shell function，因为 OpenSSH 不认 `ALL_PROXY`。

5. **子进程执行**（bwrap / sandbox-exec，异步等退出）  
   超时或 abort 时杀进程组。`finally` 里 `SandboxManager.cleanupAfterCommand()`。  
   子进程退出码回来 ≠ 写操作在策略上合法——stderr 里若匹配 `Operation not permitted`，扩展会把路径抠出来再走写权限提示，允许则 **重跑**。

6. **回收**（会话级）  
   `session_shutdown` 才 `reset()`。单条命令结束只做 per-command cleanup，代理还可以留给下一条。

`user_bash`（人在 TUI 里 `!cmd`）走同一套域名检查和 wrap；如果沙箱没亮，钩子直接 `return`，命令按 Pi 默认在宿主机执行。

## 7. 纵向链路 B：read / write / edit 为什么只是策略

1. **钩子**（`tool_call`，Pi 进程）  
   沙箱没 enable 就立刻 return，文件工具不受任何本包约束。

2. **canonicalize**（同步，realpath）  
   路径展开 `~`、能 realpath 就 realpath，不存在的路径沿父目录追。匹配是前缀或简单 `*` 正则，不是 gitignore 引擎。

3. **读**  
   不在 `allowRead` 且不在 `allowWrite` → 提示。`denyRead` **不是硬拒绝**：提示通过后写入 `allowRead`，可以盖过 `denyRead`。这是 README 用加粗警告写的。

4. **写 / 编辑**  
   `decideWritePolicy`：先 `denyWrite`（硬拒绝、不提示），再 `allowWrite`，否则 prompt。`denyWrite` 优先于 `allowWrite`。

5. **落盘**  
   人选项目 / 全局时，扩展改对应 JSON 并 `reinitializeSandbox`。  
   JSON 写完 ≠ bash 侧立刻用到新规则：要等 reinit 成功。reinit 失败只 `console.error`，**内存里的 initialized 标志不会被清掉**，可能出现「配置文件已改、运行时还是旧集合」。

完成 ≠ 就绪：用户点 Allow for this project，文件已经出现在 `.pi/sandbox.json`，但若 `refreshSandbox` 抛错，接下来的 bash 仍按旧 sandbox profile 跑。

配置合并还有一条稳定规则：某个数组（`allowRead` / `allowedDomains` 等）全局和项目都没写，用内置默认；一旦任一侧写了数组，就只用两侧的并集。**明确的空数组会废掉默认**。这不是隐藏行为，README 写过。

## 7.1 网络这一路也不在 Node 里

bash 的出站不是 JS 里 `fetch` 拦一下。SandboxManager 给被 wrap 的命令准备 HTTP/SOCKS 代理，域名白名单在代理这一侧执行。`deniedDomains` 是 OS 级硬拒，不弹窗。命令串里的 `https://...` 还会被 JS 先扫一遍——那是为了提前问人，不是真正的网络隔离。

Node 自身跟模型 API 通信不走这条 wrap。所以「沙箱开着」不等于「Pi 连不上网」。隔离的是 **被 wrap 的子进程的出站**。

`supportsNodeEnvProxy` 在 Node 22.21+ / 24+ 时会设 `NODE_USE_ENV_PROXY`，让沙箱里的 Node 程序也走代理。旧 Node 没这个开关，沙箱里跑的 `node` 可能直连。这是运行时版本差异，不是配置项。

## 8. 失败时命令会不会漏到宿主机

会。这是本包和组合包最重要的差异，必须写进肌肉记忆。

| 触发 | bash 去哪 | 文件工具 |
|---|---|---|
| `pi --no-sandbox` | 宿主机（根本不 `enableSandbox`） | 钩子因 `sandboxEnabled===false` 放行 |
| 配置 `enabled: false` | 同上 | 同上 |
| `enableSandbox` throw（缺 bwrap/seatbelt、runtime 初始化失败） | 通知失败，`sandboxEnabled=false`，之后 `localBash.execute` | 放行 |
| Alt+S / `/sandbox-disable` | `reset` 后宿主机 | 放行 |
| wrap 之后命令自己失败（权限、超时） | 仍在沙箱里失败，不回落到宿主机重跑 | — |
| 写被 OS 挡住、用户又点了 Allow | **重跑**；此时新路径应已进 allowWrite | — |

证据在 `src/extension.ts`：`execute` 开头就是 `if (!sandboxEnabled || !sandboxInitialized) return localBash.execute(...)`。这是显式 fail-open，不是疏忽。

对比组合包：`prepareBash` 在「想要沙箱但 `sandboxActive` 为假」时 **throw**，测试名就叫 `sandbox-unavailable blocks bash execution preparation`。那边漏到宿主机的唯一正门是用户打 `/guard sandbox off`。

本包没有「沙箱坏了就拒绝所有 bash」的模式。页脚锁没了，就是裸奔。

## 9. 边界、概念、常见误区

- **SandboxManager 不是守护进程。** 它是宿主里的模块 + 可选代理子进程。`ps` 里看到 socat 类进程，那是会话伴生，不是独立产品。
- **「沙箱开着」≠ 文件工具被内核拦住。** 文件工具永远在 Node 里。要硬隔离文件 I/O，得换容器类方案（guardrails README 列过 `pi-container-sandbox` / vmpi），不是本包。
- **denyRead ≠ 不能读。** 提示一次就能进 allowRead。真正硬的是 `denyWrite`。
- **session allowances 不是配置。** 内存、不落盘、Agent 读不到。reload / 重启即丢。
- **域名 `"*"` 会关掉按域提示。** 扩展会警告。这是网络策略被掏空，不是隔离被关。
- **不要把本包和组合包当成「安装了其中一个就有另一个的失败语义」。** 本包 fail-open，组合包对「沙箱不可用」fail-closed。
- **不要以为装了 pi-guardrails 就会 wrap。** 那包的 permission-gate 只是问一句「这命令危险吗」，问完仍在宿主机执行。

## 10. 失败形态与排错

| 现象 | 先查哪条链路 |
|---|---|
| 页脚没有锁，bash 能 `touch ~/.ssh/foo` | 开关闸：`--no-sandbox` / config / 初始化失败通知 |
| bash 报 Operation not permitted，文件工具却能写同一路径 | 正常：两条路。文件工具只走 JS；把路径加进 `denyWrite` 才能挡住 write/edit |
| 提示过 Allow for project，bash 仍被挡 | 配置层已写、隔离层没 reinit。看 stderr 里有没有 `Failed to reinitialize sandbox` |
| Git SSH 失败，HTTPS 正常 | macOS 代理 / `sshProxy` / `allowUnauthenticatedSocksProxy` |
| 浏览器类工具全挂 | `sandbox.json` 示例为 agent-browser 开过一大批洞；敏感环境不要抄那份 |
| 和组合包一起装，行为诡异 | 两个扩展都会动 bash。本包 fail-open，组合包 TUI 里会再 wrap 一次。不要叠装「为了更安全」 |

本地冒烟：`pi install npm:pi-sandbox`，看页脚锁；让模型 `echo hi`（应在沙箱里成功）；再 `touch /tmp/x`（默认 allowWrite 含 `/tmp`）；再让它写仓库外的路径，应弹出提示而不是默默成功。然后 `pi --no-sandbox` 重复写仓库外路径，应直接成功——这就是 fail-open 的可验证形状。

## 11. 总结

可独立验证的稳定事实：

1. 本包对 **bash 子进程**做 OS 级隔离；对 **read/write/edit** 只做 JS 策略。
2. 没有常驻 sandbox 服务。SandboxManager 活在 Pi 进程里，会话结束 `reset`。
3. 初始化失败或人为关闭之后，被替换的 bash 工具会调用 `localBash.execute`，命令漏到宿主机。
4. 配置权威是全局 + 项目两份 `sandbox.json`；会话放行只在内存。
5. 它和 pi-guardrails、pi-guard-sandbox **不是** 依赖关系上的三层蛋糕。组合包 vendor 了同类 runtime，guardrails 是另一套纯策略。

主线：

```text
想隔离 shell
  → 本包把 bash wrap 进 sandbox-exec/bwrap
  → 文件工具仍在宿主机 Node 里，靠提示拦
  → 沙箱没亮灯 = 整条 bash 回到宿主机
```

## 12. 源码阅读顺序

1. `package.json` + `index.ts` — 它是扩展不是 CLI；入口只有一个文件。
2. `README.md`「What it does」那两段 — 官方自己把 bash / 文件工具劈成两路。
3. `src/extension.ts` 的 `enableSandbox` / `execute` 开头 / `session_start` — 看了能懂 fail-open：谁把 `sandboxEnabled` 打成 false，谁调用 `localBash.execute`。
4. `src/sandbox-runtime.ts` — wrap、代理环境变量、`cleanupAfterCommand`、blocked write 的 stderr 正则。看了能懂「进程真相」：每次命令一个子进程，不是 daemon。
5. `src/policy.ts` — `decideWritePolicy` 四行。看了能懂 denyWrite 硬、denyRead 软。
6. `src/config.ts` — 默认值、数组合并（空数组会废掉默认）。参数名单易变，合并规则稳定。
7. `src/ui.ts` — 提示超时默认 Abort。看了能懂「完成提示 ≠ 放行」。
8. `test/sandbox-runtime.test.ts` + `test/policy.test.ts` — 行为合同；改策略先看这两份。

暂时不必读：`sandbox.json` 示例里为浏览器开的一长串 allow（那是洞的清单，不是主环）、runtime 包内部的 seccomp 生成器。

本地改隔离语义时优先碰的缝：`execute` 里那次宿主机回退。若你想做成组合包那种 fail-closed，改的就是这里，而不是再加一条策略。
