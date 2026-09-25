# 看懂 pi-guardrails：只拦不关，命令从来没有离开宿主机

> 本文面向已经知道 Pi 扩展会挂 `tool_call` 的读者。同目录 [`看懂 pi-sandbox.md`](./看懂%20pi-sandbox.md) 讲真正的 OS 隔离，[`看懂 pi-guard-sandbox.md`](./看懂%20pi-guard-sandbox.md) 讲把策略和隔离焊进一个 TUI 控制器。本篇只讲 **策略层**：谁在问、谁在 block、默认开了哪几扇门。
>
> **本文定位：中项目、二次开发深度。** 稳定认知放在「四条扩展、零隔离、命令本就在宿主机、pathAccess 默认关」上。规则文案、内置危险命令名单、onboarding 步骤都是易变细节。
>
> 源码基线：本仓库 `guardrails&sandbox/pi-guardrails/`，包 `@aliou/pi-guardrails` 版本 `0.17.1`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08）。该目录目前 **未纳入 git**。上游：[aliou/pi-guardrails](https://github.com/aliou/pi-guardrails)。配置库：`@aliou/pi-utils-settings`。命令 AST：`@aliou/sh`。

## 1. TLDR：它是门卫，不是牢房

```text
Pi 宿主进程
├─ 内置 read / write / edit / bash / grep / find / ls   ← 始终在宿主机执行
└─ 本包四条扩展，全部靠 hook 说话
    ├─ guardrails     文件保护策略（.env 等）
    ├─ path-access    工作区外路径（默认功能开关是关的）
    ├─ permission-gate 危险 shell（AST + 模式）
    └─ herdr          把「正在等人点批准」转发给 Herdr
                      （Herdr：终端里给多个 Agent 分屏的复用器，不是沙箱）
```

一次工具调用：

```text
模型要动某文件或跑某命令
  → tool_call 钩子
  → checkAction(规则列表) 遇到第一条 match 就停
  → 安全：什么都不返回，原工具继续在宿主机跑
  → 危险：{block:true} 或弹出确认
  → 人点允许：原工具仍然在宿主机跑
```

所以它不是：

- **不是** OS 沙箱、容器、微虚拟机。README 的 Related 列表把 [`pi-sandbox`](./看懂%20pi-sandbox.md) / `pi-container-sandbox` / vmpi 列为 **另一类产品**。
- **不是** 失败就换一条隔离路径。它没有第二条路径。钩子没拦住 = 宿主机原样执行。
- **不是** 常驻策略引擎。没有 daemon，没有独立进程审命令。
- **不是** [`pi-guard-sandbox`](./看懂%20pi-guard-sandbox.md)。组合包没 npm 依赖本包，规则语言也不一样（那边是 policy ID + 可选 DCG，这边是 glob + AST）。
- **不是** 把 bash wrap 进 bwrap。permission-gate 问完「这危险吗」，同意后还是 Pi 原来的 bash。

正面定义：一组 **同步拦截的安全策略扩展**。权威数据源是 `configLoader` 合并后的 Guardrails 配置（global / local / memory 三层，外加内置默认规则）。磁盘上的原始 JSON 不是运行时权威，迁移和 `afterMerge` 之后那份才是。

三层的人话：

- **global**：跟着 Pi 的 agent 目录走，默认在 `~/.pi/agent/` 一类位置（具体文件名由 `@aliou/pi-utils-settings` 管，易变）。
- **local**：当前项目里的 Guardrails 配置，跟仓库走。
- **memory**：本次会话的批准，不应该当成仓库里的长久规则。

`/guardrails:onboarding` 只在全局配置还没标 onboarding 完成时注册。跑过一次以后，改默认走 `/guardrails:settings` 和 `/guardrails:examples`。向导不会把本包变成沙箱。

## 2. 为什么还要一层「只拦不关」

正例：仓库里有 `.env`。模型用 `read` 去看。策略 `secret-files` 的 protection 是 `noAccess`，钩子返回 block。文件没进模型上下文。全程没有启动沙箱，也没有必要启动。

反例：模型跑 `rm -rf node_modules`。permission-gate 用 `@aliou/sh` 把命令解析成 AST，内置 matcher 认出来，TUI 问人。人点允许之后，`rm` **在宿主机上真的跑**。沙箱不存在，bwrap 不会来救你。

再反例：模型不走 `bash` 工具，而是人在 TUI 里打 `!rm -rf /`。permission-gate 的钩子写明 `isToolCallEventType("bash", event)`，**用户 !cmd 不在范围里**。这和组合包相同，和 pi-sandbox 不同（sandbox 会 wrap `user_bash`）。

所以要单独存在策略层：

| 策略层该管 | 策略层不该装成 |
|---|---|
| 「这文件是不是秘密 / 只读」 | 「进程已经进了另一个内核命名空间」 |
| 「这路径出没出工作区」 | 「出了工作区也读不到」（做不到，除非再加 OS 沙箱） |
| 「这命令像不像 rm -rf」 | 「即使用户批准，内核也会拒绝」（做不到） |

职责分工：

- **本包**：判断 + 询问 + block。核心判断在 `src/core/check.ts` 的 `checkAction`：规则列表里第一条 match 获胜。
- **人**：path-access 和 permission-gate 的批准；onboarding 选预设。
- **Pi 原工具**：真正的读盘、写盘、跑 shell。
- **OS 沙箱（别人家的包）**：只有你另外安装 pi-sandbox 或组合包时才出现。本包零依赖它们。

## 3. 先看整体架构，不急着看类名

文档视角：

```text
接入层     /guardrails:onboarding / :settings / :examples
   ↓
配置层     内置 DEFAULT_CONFIG ⊕ global ⊕ local ⊕ memory（按规则 id 覆盖）
   ↓
功能开关   enabled / features.policies / permissionGate / pathAccess
   ↓
四条扩展   各自挂 tool_call 或事件总线
   ↓
核心引擎   Action → Rule[] → Safety →（可选）Decision
   ↓
副作用     block 返回值；事件：blocked / prompt opened|closed / risk
```

进程真相：四条扩展和核心引擎全在 **Pi 宿主进程**。`package.json` 的 `pi.extensions` 一次装四份入口：

```text
./extensions/path-access/index.ts
./extensions/guardrails/index.ts
./extensions/permission-gate/index.ts
./extensions/herdr/index.ts
```

没有第五个进程。herdr 扩展甚至不拦截工具：它只监听 `guardrails:prompt:opened|closed`，转成 `herdr:blocked`，让 Herdr UI 显示「Guardrails 正在等人」。关掉 Herdr，策略照跑；关掉策略，Herdr 没事件可报。

| 节点 | 载体 | 同步？ | 完成 ≠ 就绪 |
|---|---|---|---|
| 配置 load | 宿主读 settings 文件 + 跑 migrations | 启动时 await | 文件里有规则 ≠ `features.policies` 为 true |
| policies 钩子 | `tool_call` | await `checkAction`（里面可能 `stat`） | block 返回 ≠ 模型已经改主意；只是这调用没执行 |
| path-access | `tool_call` + TUI 组件 | 有 UI 才 ask，没 UI 当 deny | 点「允许本会话」≠ 已写入 local 配置 |
| permission-gate | 仅 bash 的 `tool_call` | AST 解析失败会退回子串匹配 | 解析成功 ≠ 内置 matcher 覆盖了所有变形 |
| herdr | 进程内事件 | 同步 emit | 提示已弹出 ≠ Herdr 对面一定有人 |

文档视角说「adds safety checks so agents are less likely to…」。进程真相是：**检查失败就原样执行；检查通过也原样执行。** 「安全」完全等于「钩子有没有返回 block」。

## 4. 运行形态：四份插件，零守护

加载时机：Pi 启动时按 `pi.extensions` 把四个 default export 都跑一遍。每个入口自己 `configLoader.load()`。`session_start` 时 guardrails 扩展清空「已加载功能」集合、只保留 `policies`，再 `emit(FEATURE_REQUEST)`；另外两个功能扩展听到请求后 `FEATURE_REGISTER` 回来。这是扩展之间的进程内总线，不是 RPC。

没有常驻：

- 没有策略服务器。
- 没有把命令送到外部审。
- 没有 session 外的后台扫描。

和另外两包比运行形态：

| | pi-sandbox | pi-guardrails（本篇） | pi-guard-sandbox |
|---|---|---|---|
| 形态 | 一个扩展，替换 bash 工具 | **四个扩展**，不替换 bash | 一个扩展，TUI 里替换 bash |
| 常驻进程 | 无（可有代理子进程） | 无 | 无（DCG 是每次 spawn 的短进程） |
| 非 TUI | 仍然 enableSandbox | 钩子仍在；没 UI 的 ask 变 deny | **整包不初始化** |
| 命令执行位置 | 沙箱子进程（成功时） | **永远宿主机** | 沙箱子进程（成功时） |
| 失败漏到宿主机？ | 会（fail-open） | 问题不成立：没有「里面」可漏 | 沙箱不可用则拦住 |

默认功能开关（`src/shared/config/defaults.ts`，易变的是具体规则，稳定的是这三项）：

- `enabled: true`
- `features.policies: true`
- `features.permissionGate: true`
- `features.pathAccess: false` ← 工作区边界默认 **关**

装完本包不等于「出了仓库就不能读」。那扇门要 onboarding 或 settings 打开。

## 5. 三包对照：本篇只拥有「策略覆盖面」这一列

| 问题 | pi-sandbox | pi-guardrails（本篇） | pi-guard-sandbox |
|---|---|---|---|
| 文件秘密（.env） | `denyWrite` 硬、读靠提示；默认 denyWrite 含 `.env` | **policies 默认 noAccess 一批 env 文件** | `protectedPaths` + `sensitiveReadDeny` |
| 工作区外路径 | 读默认 deny `/Users` `/home`，但提示可放行 | path-access，**默认关** | 出仓库的 write/edit 要批准 |
| 危险命令 | 不认命令语义，只认域名和写失败 | **AST 内置 matcher + 模式** | 正则 policy ID，或外部 DCG |
| grep/find/ls 读秘密 | 不管（不是文件工具那三条） | `noAccess` 会拦这些工具名 | 只拦 read/write/edit/bash |
| 用户 !cmd | wrap 进沙箱 | **不拦** | **不拦** |
| 规则怎么写 | 路径/域名 glob 数组 | glob + protection 枚举 + 命令模式 | policy ID 列表，不是裸正则 |
| 和另外两包关系 | 可叠装，但会双重要 bash | Related 里链到 sandbox，不 import | 不 import 本包；策略是重写的 |

叠装后果（源码能推出、运行时未在本仓库验证）：pi-sandbox 的 bash 已经 wrap 之后，本包的 permission-gate 仍会先在 `tool_call` 上看原命令字符串。顺序取决于 Pi 加载扩展的顺序。不要靠「两个都装 = 自动焊好」。要焊好的那份是组合包。

## 6. 纵向链路 A：文件策略（policies）

1. **开关**（同步）  
   `config.enabled && config.features.policies`，否则钩子 return。完成这次判断 = 本包对这次调用不存在。

2. **选规则**（同步）  
   `compilePolicies` → 按工具名过滤 `BLOCKED_TOOLS` → 按 protection 强度排序（noAccess > readOnly）。  
   `noAccess` 覆盖 `read, write, edit, bash, grep, find, ls`。  
   `readOnly` 覆盖 `write, edit, bash`。  
   完成编译 ≠ 某文件已被保护：还要路径匹配且（默认）文件存在。

3. **抽目标**（可能异步）  
   `extractTargets` 从不同工具的 input 里抠路径。bash 命令里的路径是「看起来像路径」的猜测，不是内核看到的 open() 参数。
   这里和 OS 沙箱的差距最大：bwrap 不需要猜你的命令串里有没有 `.env`，它拦的是真正的 open。本包拦不住 `cat $(echo .env)` 这类拼出来的路径，也拦不住 `python -c` 打开文件。要那一层，去沙箱包。

4. **判定**（`checkAction`，可能 `stat`）  
   路径规范化（相对仓库 / `~/` / 绝对）。命中 `allowedPatterns` 放行。`onlyIfExists` 默认 true：文件还不在磁盘上，规则当没看见。  
   这是完成 ≠ 就绪的典型点：新建 `.env` 之前写它，可能绕过「只保护已存在文件」的默认。

5. **拦截**  
   命中则 `emitActionBlocked` 并 `{block:true}`。没有「问一句再写」——policies 这条链路是硬拦，批准流在 path-access / permission-gate。

## 7. 纵向链路 B：工作区边界（path-access）

1. **默认关。** 没打开 feature 就当本链路不存在。

2. **边界**（同步）  
   工作区 cwd 内：allow。`allowedPaths` 里 directory 是前缀、file 是精确匹配。`/dev/null` 默认在名单里。

3. **三种 mode**  
   `allow`：等于关掉这层。`block`：出界直接 deny。`ask`：有 UI 弹窗，没 UI 当 deny。

4. **批准过宽会拒绝**  
   `isGrantTooBroad` 拦住把 `/` 或家目录整棵树永久放行的操作，降级成 allow once。

5. **持久化**  
   session grant 在 memory scope；always 写入 local。  
   点允许 ≠ 下次换一个相对路径写法还能中：要看规范化后的绝对路径。

bash 出现在这条链路里，是因为命令行可能带出界路径。这仍然不是 wrap：只是解析、询问、block。批准后 bash 在宿主机跑，可以读那个出界路径。

## 8. 纵向链路 C：危险命令（permission-gate）

1. **只认工具名 `bash`。** 自定义 shell 工具、`!cmd`、把命令写进脚本再 `bash file.sh` 的文件内容，都不走 AST。

2. **会话白名单**  
   `isCommandAllowed` 命中则整段跳过。这是人点过「本会话允许」的记忆，不是沙箱 profile。

3. **autoDenyPatterns**  
   匹配则直接 block，不问。默认空。

4. **AST 优先，失败退化**  
   `src/core/commands/dangerous.ts`：`parse` 成功就 `walkCommands` 跑内置 structural matcher（认的是词结构，不是「整串 includes」）。parse 抛错才用 fallback 子串。  
   完成解析 ≠ 所有绕过都被抓住。`rm -rf` 的空格变形、通过 `python -c` 删文件，内置 matcher 可以看不见。

5. **问人**  
   `requireConfirmation` 默认 true。没 UI 时按配置走 deny 而非空放。人选 allow-session 只记这条命令串。  
   人选 stop 会 `ctx.abort()` 并 block，比单纯 deny 多停一轮 Agent。

6. **事件**  
   弹出前 `prompt opened`，关掉 `prompt closed`。herdr 靠这对事件亮灯。风险本身另外发 `guardrails:risk:detected`。

和组合包的 bashPolicy 不要混：本包是「解析再匹配」，组合包内置层是「一串命名正则」。DCG 更是外部二进制，本包不用。

## 9. 边界、概念、常见误区

- **block 不是隔离。** 没被 block 的调用，以及被允许的调用，都在宿主机。把页脚或提示当成「已经进沙箱」是错的。
- **pathAccess 默认 false。** 演示里看到工作区边界，多半是 onboarding 打开的，不是装上就有。
- **policies 默认 onlyIfExists。** 「规则里写了 `.env`」≠「模型新建 `.env` 会被拦」。
- **四个扩展不是四个产品。** 一个 npm 包、一次 install、共享一份 configLoader。改默认规则要同时记得 examples 预设。
- **herdr 扩展没有安全效果。** 删掉它不会让 `.env` 变可读；它只是把等待状态送去复用器。
- **不要把本包的 AST 门和组合包的 DCG 当成可替换插件。** 协议不同、安装方式不同、失败语义不同。
- **`checkAction` 没有「全部规则投票」。** 第一条 match 就返回。排序靠 protectionRank，所以 noAccess 优先于 readOnly。
- **配置三层不是简单后写覆盖整份文件。** 规则按 `id` 进 Map；permission-gate 的 customPatterns 一旦出现，会 **关掉** 内置 matcher（`useBuiltinMatchers = false`）。这是踩坑点。

## 10. 失败形态与排错

本包几乎没有「异步还没建好索引」这类完成≠就绪，但有开关和退化：

| 现象 | 先查哪条链路 |
|---|---|
| `.env` 被读走 | policies 开关？规则 id 被 local 覆盖成 protection none？onlyIfExists 而文件当时不存在？走的是 bash `cat` 且目标抽取没抽出路径？ |
| 出仓库的 `read` 没问 | `features.pathAccess` 是不是还在默认 false |
| `rm -rf` 没问 | 是不是 `!cmd`？是不是自定义工具？AST 失败且 fallback 子串没写这条？session grant 已经放行过？ |
| 一配 customPatterns，原来的 sudo 也不问了 | `afterMerge`：自定义模式会关闭内置 matcher |
| Herdr 没有「正在批准」灯 | herdr 扩展没加载，或 prompt 事件没发出；策略仍可能在拦 |
| 和 pi-sandbox 一起装，提示套提示 | 两边都在 hook / wrap。要单一入口用组合包，不要叠 |

本地冒烟：`pi install npm:@aliou/pi-guardrails`，跑 `/guardrails:onboarding`，让模型 `read` 一个真实存在的 `.env`，应被 block；再在 **不打开** path-access 时 `read` 仓库外一个无害文件，应成功——用来确认「默认没有工作区牢房」。然后 `!echo host-ok` 应不受 permission-gate 约束。

## 11. 总结

可独立验证的稳定事实：

1. 本包是策略，不是隔离。没有任何 wrap、没有任何离开宿主机的执行路径。
2. 一次安装四条扩展；真正拦工具的是 policies / path-access / permission-gate。herdr 只转发等待状态。
3. `checkAction` 第一条 match 获胜。权威配置是 loader 合并 + 迁移之后的那份，不是你打开的原始 JSON。
4. path-access 默认关；policies 和 permission-gate 默认开。
5. 用户 `!cmd` 不在 permission-gate 范围里。要护 !cmd，看 pi-sandbox 的 `user_bash`，不是本包。

主线：

```text
想少让 Agent 误碰秘密和危险命令
  → 本包在 tool_call 上 block 或提问
  → 提问通过后，命令和文件 I/O 仍在宿主机
  → 真要把 bash 关进内核，去装沙箱包，别改本包的规则列表
```

## 12. 源码阅读顺序

1. `package.json` 的 `pi.extensions` — 四入口，不是一个。
2. `README.md` 开头 + Related — 官方把本包和沙箱类产品并列，不当成同一层。
3. `src/core/check.ts` — 六行引擎。看了能懂「策略 = 第一条 match」。
4. `src/shared/config/defaults.ts` + `loader.ts` 的 `afterMerge` — 默认开什么、规则 id 怎么盖、customPatterns 如何关掉内置 matcher。
5. `extensions/guardrails/index.ts` + `rules.ts` 的 `BLOCKED_TOOLS` — 文件策略覆盖哪些工具名。
6. `extensions/path-access/index.ts` + `src/core/paths/access.ts` — 工作区边界；没 UI 变 deny。
7. `extensions/permission-gate/index.ts` + `src/core/commands/dangerous.ts` — AST 门，以及它只管 `bash` 工具。
8. `src/shared/events.ts` + `extensions/herdr/index.ts` — 总线事件；herdr 为什么零策略。
9. `extensions/*/index.test.ts` — 行为合同。改规则先看测试里的「该拦 / 不该拦」。

暂时不必读：`src/shared/config/migration/00*.ts` 的历史格式（只在升级旧配置时碰到）、onboarding 向导 UI 组件。

二次开发优先碰的缝：新增一种保护，先决定是 Rule（进 `checkAction`）还是新扩展；不要在 permission-gate 里塞文件系统隔离，那是沙箱包的活。
