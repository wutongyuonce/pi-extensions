# 看懂 pi-mcp-adapter：MCP 进程在外面，Pi 里只挂一层代理

> 本文面向第一次接触 `pi-mcp-adapter`、但已经知道「Pi 是编码 Agent、扩展会往宿主里注册工具」的读者。重点不是罗列协议方法名，而是讲清：MCP 工具怎样变成 Pi 能调的东西、MCP server 进程和 Pi 宿主谁在哪一侧、一次工具调用穿过哪几层、配置到底听谁的。
>
> **本文定位：中型项目、二次开发深度。** 稳定认知放在进程边界、工具表面（proxy / namespace / direct）和配置权威源上；超时默认值、搜索文案、OAuth 面板文案属于易变细节。包版本 `2.31.0`，功能面很宽（OAuth、UI widget、采样回调都有），但主线仍是「少占上下文、按需拉起外面的 MCP 进程」。
>
> 源码基线：本仓库 `@nicobailon/pi-mcp-adapter`，包版本 `2.31.0`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13ed69a55f94889194018f652adf628ddc4b`（2026-09-03）。上游独立仓库：[nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)。协议：[Model Context Protocol](https://modelcontextprotocol.io/)。宿主扩展 API：[pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)。

## 1. TLDR：它不是把 MCP 工具倒进上下文

Pi 自己不会说 MCP。这个扩展补上三件事：读配置、按需连上外面的 MCP server、把结果折成 Pi 的工具结果。模型默认只看见一把代理工具 `mcp`（大约两百 token），真正的工具清单按需搜索。

```text
配置文件们（谁说有哪些 server）
        ↓ 启动时合并，多数 server 此时还不连
Pi 宿主进程里的适配器（Client，不是 Server）
        ↓ 模型调 mcp({ tool, args }) 或一把 direct 工具
按需拉起 / 连上 MCP server（子进程、HTTP、或别人的 socket）
        ↓ JSON-RPC
工具结果折回 Pi 上下文
```

所以它不是：

- **不是** 常驻 MCP 网关。没有独立的 adapter daemon；扩展跟着 Pi 进程，会话关了就拆连接。
- **不是** 把每个 MCP 工具都注册进模型工具列表。那正是它要避免的事。
- **不是** MCP server 本体。它是 **Client**：stdio 时是父进程，HTTP 时是客户端，socket 时只握着自己的那头。
- **不是** 配置的唯一文件。`~/.pi/agent/mcp.json` 只是其中一层，而且常常不是最高层。

正面定义：它是挂在 Pi 上的 **MCP Client 适配器**。职责是「少占上下文、晚启动、把外面的工具折成 Pi 工具」。

权威数据源（先记这四行，后文展开）：

- **有哪些 server、怎么启动**：合并后的 `mcpServers`。文件、插件、包、内存 `config` 都可能贡献，后写的覆盖先写的。
- **这次会话能不能搜到工具名**：`~/.pi/agent/mcp-cache.json`（派生缓存）。缓存能搜 ≠ 进程活着。
- **这次调用的真实结果**：活着的 MCP server。缓存从不代替一次真正的调用。
- **OAuth / 可选的 bearer 仓库**：操作系统凭据库，按 **server 名 + URL** 绑定。明文 `tokens.json` 只是升级时的进口，不是长期权威。

四件事不要当成同一个时刻：

```text
配置合并成功     ≠ 任何 MCP 进程存在
缓存里有工具名   ≠ 能立刻 call 成功
connect 返回     ≠ 模型已经看见新的 direct 工具
工具 RPC 返回    ≠ 带界面的 widget 会话结束
```

## 2. 为什么不「把 MCP 工具全注册给模型」

Mario 写过 [why you might not need MCP](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)：一份工具定义很啰嗦，一个 server 就能烧掉上万 token，连几个就把上下文窗口的前半截吃掉——还没开始干活。他的结论是：别用 MCP，自己写 CLI。

这个扩展认账，但不放弃生态。数据库、浏览器、工单系统已经有现成 MCP server。它选的折中是：

| 该走这个适配器 | 不该走它 |
|---|---|
| 想用现成 MCP server，又不想把 26 个工具 schema 塞进每一轮 | 工具就三四个、定义很短，直接写成 Pi 扩展更干净 |
| 同一个 server 配置想在 Cursor / Claude / Pi 之间共用一份 | 把 Pi 当成 MCP server 去给别人连（方向反了） |
| 大多数工具很少用，偶尔搜一下再调 | 每个工具都必须出现在模型的一等工具列表里（那是 `directTools` 的特例，不是默认） |

职责分工可以压成四行：

- **宿主模型**判断「要不要搜 MCP、调哪一把」。
- **适配器**判断「这名字对应哪个 server、现在要不要连、参数怎么校验、结果怎么折」。
- **MCP server 进程**判断「这个工具实际做什么」。适配器不当业务实现。
- **配置文件**判断「有哪些 server」。缓存、状态栏、`/mcp` 输出都是派生视图。

不要把「扩展已安装」理解成「MCP 已连上」。安装只是把 Client 代码加载进 Pi。

搜索为什么打缓存、不打活进程：如果每次 `mcp({ search })` 都去 spawn 三五个 server，代理省下来的上下文会被启动延迟吃回去，lazy 也失去意义。缓存是「上次连上时看见的菜单」；菜单能点，厨房（进程）可以还没开火。菜单过期了，再连一次换新菜单。

## 3. 先看整体架构，不急着看类名

文档视角（职责）：

```text
对话层         用户说话 → 模型决定调 mcp / 某把 direct 工具 / 某条 /mcp 命令
     ↓
工具表面层     三张脸：一把总代理 mcp、每 server 一把命名空间代理、可选的一等 direct 工具
     ↓
解析与门禁     对上 server+工具名、审批、OAuth、失败冷却
     ↓
连接层         该连才连：stdio 拉子进程 / HTTP 打远端 / Unix socket 握已有 mux
     ↓
协议层         MCP Client 发 JSON-RPC，等结果或进度
     ↓
折回层         内容变成 Pi 的 text/image；太大则落临时文件；可选输出守卫
```

进程真相（谁在哪个进程里）：

```text
Pi 宿主进程
├─ 扩展代码（读配置、注册工具、生命周期定时器）
├─ MCP Client（SDK）
├─ 可选：本机 OAuth 回调 HTTP
├─ 可选：给 UI widget 用的本机 HTML 服务
└─ 元数据缓存的文件读写
        │  stdio：父进程 spawn
        │  HTTP：普通客户端
        │  socket：只连，不养对面
        ▼
MCP server 进程（默认不在扩展加载时出现）
```

两张图的差异：文档说「connect MCP servers」，听起来像起了一个服务。进程上，**被 connect 的是别人**；适配器自己始终是 Client，而且默认还是懒的。

| 文档视角容易读成 | 进程上实际是 |
|---|---|
| 适配器在跑 MCP | 适配器在跑 MCP **Client** |
| `/mcp` 列出 3 个 server 就是 3 个进程 | 常常是 0 个进程 + 3 份配置 + 一份缓存 |
| 状态栏 `connected` | 已经和模型工具表面同步过的连接快照，不是「配置里有」 |
| `pi-mcp-adapter` CLI | 脚手架 / token 帮手，会话里不在 |

状态快照（给别的扩展订阅的那种）读起来像运行时真相，约定是：读状态 **不** 连 lazy server、**不** 开认证、**不** 把 SDK Client 或凭据塞进事件。`connected` 要等 direct 工具表面已经和权威清单对过一次才发——空清单也会把过期的缓存工具从模型面前拿掉。这是「表面已同步」，不是「进程刚起来」。

CLI `pi-mcp-adapter` 也不是运行时。它只做 `init`（侦测别的宿主配置、脚手架）和 bearer token 的存取。真正干活的是 Pi 加载的扩展。

## 4. 实际怎样运行：扩展，不是网关

形态是 **Pi 扩展**。`pi install npm:pi-mcp-adapter` 之后，代码进宿主进程，在 `session_start`（以及「有 eager / keep-alive server」时的扩展加载瞬间）初始化。没有单独的监听端口代表「适配器本体」。

常驻吗？分两层：

- **适配器**：Pi 会话在，它就在；`session_shutdown` 时停 runtime、关连接、拆 UI 服务。
- **某个 MCP server**：默认 `lifecycle: "lazy"`，第一次真正调它的工具才连。闲置默认 10 分钟断开（`settings.idleTimeout`，单位是分钟；`0` 表示不断）。缓存还在，所以断开之后搜索/列表仍能工作。

四种生命周期（易变的是超时数字，稳定的是「何时出现进程」）：

| 模式 | 启动时连吗 | 第一次调用后 | 掉线 |
|---|---|---|---|
| `lazy`（默认） | 不 | 闲置会关 | 下次再调再连 |
| `eager` | 连 | 默认闲置关超时为 0 | **不**自动重连 |
| `keep-alive` | 连 | 不闲置关 | HTTP 会话过期会重连，并刷新工具清单 |
| `lazy-keep-alive` | 不 | 一旦拉起就留下，行为像 keep-alive | 同 keep-alive |

闲置关闭和 keep-alive 探活 **不是 OS cron，也不是独立 daemon**。载体是适配器进程里的生命周期管理：会话还在就周期检查；会话 shutdown 就把时钟拆掉。keep-alive 探活还会挂在「用户即将输入 / 适配器即将触发一轮」前面，避免模型开口时连着一具已过期的 HTTP 会话。

谁拉起？stdio 下是 **Pi 宿主** `spawn` 配置里的 `command`（常见是 `npx`）。`args` / `env` / `cwd` 会做环境变量插值；`cwd` 必须是已经存在的目录，否则拒绝启动。HTTP 下没有子进程，对面是已经在跑的服务。Unix socket 下适配器 **明确不养** mux：它只握自己的 client socket；对面进程、重启策略、权限都是 `rmcp-mux` 的事。

初始化有两道门，不要看成两个适配器：

- **加载期**：扩展模块一进进程就看配置。只要有未禁用的 `eager` / `keep-alive` server，立刻起一轮 runtime。这是给「嵌入 Pi、从不发 `session_start`」的宿主用的。
- **会话期**：`session_start` 再起一轮会话自己的 runtime，**取代**加载期那一轮。`session_shutdown` 只拆当前这一轮。

所以「Pi 还在、会话已经切过」时，旧连接必须被停掉。runtime 有一个会话级的 abort 所有者：停了之后 UI 调用、延迟的 connect、OAuth 回调都不再碰已经作废的 `ExtensionContext`。

一条必须分开的完成点：

- 扩展初始化完成 ≠ 任何 MCP 进程已起来
- 缓存里有工具名 ≠ 能马上 `call`
- `connect()` 返回 ≠ 模型已经看见新的 direct 工具（有热加载，也有「重启后再有」的路径）
- 工具调用返回 ≠ UI widget 会话结束（带界面的工具另有一条浏览器会话）

## 5. 三种运输，三张工具脸

每个 server 必须恰好配置 `command`、`url`、`socket` 之一。配两个就拒绝。这是运输，不是「哪种 MCP」。

```text
command  →  stdio 子进程，JSON-RPC 走 stdin/stdout。Pi 是父进程。
url      →  HTTP / SSE。Pi 是客户端。OAuth 多半发生在这条上。
socket   →  本机 Unix socket。Pi 只连，不启动、不接管对面。
```

工具怎样出现在模型面前，是另一条轴：

```text
默认        一把 mcp。模型 mcp({ search }) 再 mcp({ tool, args })。
命名空间    mcp__<server>，execute 吃 { tool, args }，内部仍走同一条调用链。
            给 tool-groups / slow-mode 用，不必把该 server 改成 directTools。
direct      指定工具提升成和 read / bash 并列的一等 Pi 工具。
            从缓存注册，启动时不必连 server。
```

`directTools` 可写在全局 `settings` 或单个 server 上；单 server 覆盖全局。`excludeTools` 在 `includeTools` 之后生效。环境变量 `MCP_DIRECT_TOOLS` 还能再切一刀（易变，查当前 README）。

模型看见的名字不是 MCP 原始名。`settings.toolPrefix`（单 server 可覆盖）决定怎么拼：

- `server`（默认）：`my-server` + `search` → `my-server_search`
- `short`：去掉名字里的 `-mcp` 后缀再拼
- `none`：几乎就是原始名（撞车风险最高）
- `mcp`：`mcp__` 前缀，给习惯 Claude 那种命名的人

命名空间代理的工具名是 `mcp__<规范化后的 server>`，和上面那套前缀是两条线。两个 server 规范化成同一个 `mcp__…` 时，**两把都不注册**，避免慢速模式绑到错的 server。

`includeTools` / `excludeTools` 用原始名或已经拼好的前缀名都能匹配。它们只影响「这把工具出不出现在表面」，不改 MCP server 自己暴露什么。

正反例：

- 浏览器 MCP 有二十多个工具，平时只用截图 → 留在代理后面。
- `github` 的 `create_pull_request` 每轮都要用 → 写进该 server 的 `directTools` 数组。
- 某个巨大 server 全局开了 `directTools: true`，但这一台机器不该占上下文 → 该 server 写 `directTools: false`。

`freezeDirectTools: true` 之后，清单刷新不再改已经注册给模型的 direct 表面。这是运行时开关，不是配置权威源。

另外两张「也像工具、但不是 MCP 工具列表里那一行」的脸，知道边界即可：

- **Prompt**：MCP server 声明的提示模板，适配器挂成 Pi 斜杠命令（`mcp__<server>__<prompt>` 这种形状）。第一次真正用才去连。它不是模型工具列表里的一项。
- **Resource**：可被折成「读这个 URI」的工具，受 `exposeResources` 和 include/exclude 管。大二进制会落到临时文件，有会话级字节/文件上限；这是折回层的事，不是又一种运输。

别的 Pi 扩展可以在运行时登记一个 server（内存里一份定义，不写进 json）。被同名配置项挡住的 runtime 登记不会从快照 API 露出去——**配置文件仍比程序塞进来的定义硬**。读快照的公开 API 也不返回 SDK Client、运输或凭据。

## 6. 纵向链路一：会话开始，多数进程还没出现

载体：Pi 宿主进程，同步读文件 + 异步 connect。触发点是 `session_start`；若配置里已有 `eager` / `keep-alive`，扩展加载时也会先跑一轮，避免有的宿主从不发 `session_start`。后者会被后来的会话 runtime 取代。

```text
读配置（文件合并） → 读缓存 → 重建「能搜到的工具名」
  → 只对 eager/keep-alive（或缓存全空）去 connect
  → 注册 mcp / 命名空间 / direct
  → 状态栏快照
```

### 6.1 配置层：收到 cwd 与可选 override → 产出一份内存里的 `mcpServers`

这一层是**同步文件 IO**，不 spawn。合并规则见第 8 章。内存 `createMcpAdapter({ config })` 走另一条：不读这些文件，也不写 `.pi/mcp.json` 的 disable 覆盖。

### 6.2 缓存层：收到 server 定义哈希 → 产出 toolMetadata 映射

缓存路径默认 `~/.pi/agent/mcp-cache.json`（`$PI_CODING_AGENT_DIR` 会改 agent 目录）。哈希只吃「这个 server 是谁、会产出什么工具」的字段：`command` / `args` / `url` / `headers` / `env` / `cwd` / `socket` 等。`lifecycle`、`idleTimeout`、超时、debug **不进哈希**——改闲置策略不该让工具清单作废。

缓存有效（默认最多 7 天，易变）时：搜索、describe、direct 注册都可以在 **零连接** 下工作。

缓存无效或文件不存在：搜索是空的或过期的。配置了 `directTools` 但还没缓存时，这次会话先走代理；后台会去连一次好写入缓存。通知文案可能说「重启后再有」，当前会话也可能热加载——**完成写入缓存 ≠ 模型本轮已经看见新工具**。

缓存文件本身不存在时，初始化会先写一份空壳，再把 **所有** 未禁用 server 当成启动型去连一次（`bootstrapAll`）。这是「第一次装上、机器上还没有 mcp-cache.json」的特殊路径，不是 lazy 被偷偷改成 eager。有缓存文件但某个 server 的哈希对不上，只影响那一个 server：它从「可搜」变成「要先连上才知道有什么」。

### 6.3 连接层（仅启动型 server）：收到定义 → spawn 或 HTTP → 产出活连接 + 刷新缓存

`eager` / `keep-alive` 在这里真正出现 MCP 进程。失败记入 60 秒冷却：冷却期内懒连接直接放弃，避免启动风暴。数字本身易变，语义稳定——**刚失败过的 server 不会被搜索或下一次 call 立刻再砸一遍**。

`lazy-keep-alive` 不在这一层出现进程。它只是在「第一次 call 成功 connect 之后」被标成保活，从此跟 `keep-alive` 走同一套探活。配置写成 lazy-keep-alive、但还没人调过它的工具时，进程真相仍然是「没有这个子进程」。

### 6.4 表面层：收到 metadata → `pi.registerTool` → 模型本轮能看见的工具集

`mcp` 总是在。命名空间代理按「非 direct 的 server」各注册一把。direct 按缓存清单注册。`disabled: true` 的 server 不进表面。

到这里，对默认的 lazy server 而言：**配置完成、工具可搜，进程仍不存在。**

## 7. 纵向链路二：一次 `mcp({ tool, args })` 从进到出

这是全文最值得跟进行的路径。direct 工具和命名空间代理最后都汇进同一条 `executeCall`。

```text
模型发工具调用
  → Pi 把 execute 交给扩展（宿主进程，随调用的 AbortSignal）
  → 对上 server + 原始工具名
  → 门禁（禁用 / 冷却 / 审批 / OAuth）
  → 没有活连接就 connect（这里才可能出现 MCP 进程）
  → Client 发 call（异步 JSON-RPC，可 abort）
  → 折内容、守卫、可选 UI
  → 作为 Pi 工具结果回到模型
```

### 7.1 对话层：收到用户问题 → 模型选工具 → 产出一次 Pi 工具调用

默认模型看见的是 `mcp`，参数是「搜 / 描述 / 调 / 看状态」这一类，而不是三十份 schema。direct 工具则看起来像普通 Pi 工具，参数已是 MCP 那份 input schema。

### 7.2 解析层：收到 `tool` 字符串 → 产出 (serverName, originalName) 或明确错误

名字带 server 前缀（默认 `server` 模式：`my-server_search`）。多个 server 规范化后撞名会报 `ambiguous_tool`，要用 `server` 参数消歧。请求的是 Pi 内置工具名，会明确拒绝并让模型直接调那个内置工具。

这一层读的是 **内存里的 toolMetadata**（多半来自缓存）。它不连接。**解析成功 ≠ server 在跑。**

### 7.3 门禁层：收到身份 → 产出「允许继续」或带 error 的工具结果

按顺序，都在宿主进程里：

- server `disabled` → 立刻失败，不连。
- 60 秒失败冷却仍在 → 不连。
- `approveTools` 命中 → 等人点头（TUI）；headless 没有人点，就停在这一层。
- 连接状态是 `needs-auth` → 可按 `settings.autoAuth` 试一次；失败则返回「去跑认证」，仍然还没有业务调用。

### 7.4 连接层：收到 ServerEntry → 产出 SDK Client（异步）

没有活连接时，这里才 `spawn` / 打 HTTP / 连 socket。stdio 的 `cwd` 要真实存在。运输建好后会拉工具/资源/提示清单，写回缓存。

`lazy-keep-alive` / `keep-alive` 在成功 connect 之后被标成保活，闲置定时器不再关它。普通 `lazy` 则继续受 idle 时钟管——**这次调用成功 ≠ 进程会一直留着**。

### 7.5 协议层：收到 originalName + args → 对面执行 → 产出 MCP 结果（异步）

载体：已有运输上的 JSON-RPC。可被用户 Esc / 工具 `signal` abort。调用方的 signal 会和 runtime 自己的 abort 合成一把：会话已经 shutdown 时，即使模型还想重试，Client 侧也会停。

HTTP 会话被对面判定过期时，会走恢复：关掉旧 Client、重连、再发一次同一把工具。这是适配器内部的一次重试，不是模型又调了一次。进度回调（如果有）只是 TUI 通知，不是成功证明。

对面是 MCP server 自己的逻辑。适配器在这一层不当业务，只当 Client。

方向偶尔会反：对面可以请宿主做一件模型补全（采样）。那是 **MCP server 进程 → Pi 宿主再调模型**，要人确认（除非 autoApprove）。采样不是「又一个 MCP 工具」，是对面把 Pi 当成 LLM 来用。上下文纳入、工具调用这类采样能力当前直接拒绝。

### 7.6 折回层：收到 MCP 内容 → 产出 Pi `content` + `details`

文本进上下文；二进制超过阈值落到临时目录；可选输出守卫截断。`details` 里带 `server` / `tool`，失败时带稳定的 `error` 码（`tool_not_found`、`server_disabled`、`auth_required`…）。Pi 再靠 `tool_result` 钩子把 MCP 失败标成真正的工具错误，而不是一段看起来成功的文本。

带 UI resource 的工具会在本机再开一条 HTML 会话。工具 RPC 返回 ≠ 用户已经在浏览器里点完。那是另一条会话，consent 门另算。

把一次默认 lazy + stdio 的调用画成进程树，长这样：

```text
pi（宿主）
├─ 扩展：解析 my-server_search，缓存命中
├─ 扩展：spawn npx …          ← 这里才有第二个进程
│     └─ MCP server（stdio）
│           读 stdin 上的 JSON-RPC，写 stdout
├─ 扩展：把 stdout 折成 Pi 工具结果
└─ 10 分钟没再调 → 扩展 close → 子进程退出
```

HTTP 版没有第二棵子进程。socket 版第二棵进程在 mux 那边，Pi 退出也不会去 kill 它——这是故意的。

## 8. 配置权威源：谁覆盖谁

「我改了 mcp.json 怎么没生效」几乎总是合并顺序问题，不是 Client 坏了。

普通模式（`PI_MCP_CONFIG_MODE` 不是 `exclusive`）下，**从低到高**：

```text
包内 MCP（名字不与插件冲突）          最低
Agent Plugins 的 mcp.json（名前缀 plugin__server）
hostConfigDiscovery=on 时：Cursor / Claude / Codex / … 侦测到的文件
~/.config/mcp/mcp.json                 用户级共享
~/.agents/mcp.json
~/.agents/mcp/mcp.json
~/.pi/agent/mcp.json                   Pi 全局（默认写入口之一）
<cwd>/.mcp.json                        项目共享
<cwd>/.pi/mcp.json                     项目 Pi 覆盖     最高文件层
```

后合并的字段盖住先合并的。同名 server 换了 `url` 时，**旧 URL 上的 headers / bearer / OAuth 不得跟着继承**——否则低信任的高层配置能把凭据送到新地址。这是合并代码里写明的安全约束，不是风格问题。

一个具体形状：

```text
~/.config/mcp/mcp.json     github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
~/.pi/agent/mcp.json       github: { directTools: ["create_pull_request"], lifecycle: "lazy" }
.mcp.json                  github: { env: { GITHUB_TOKEN: "…" } }
.pi/mcp.json               github: { disabled: true }     ← /mcp disable 写在这
```

有效结果是：还是那个 npx 命令，带上项目的 env 和 Pi 的 directTools，但这个项目里禁用。共享文件没被改。拿掉 `.pi/mcp.json` 里的 disabled（或 `/mcp enable`），其它字段都还在。

几个例外，不要和上面那张梯子混：

- `createMcpAdapter({ config })`：只用这份内存配置，不读不写那些文件。`/mcp disable` 在这模式里不可用。
- `configPath` / `--mcp-config`：替换「Pi 全局」那一层的路径，不是再叠一份。
- `PI_MCP_CONFIG_MODE=exclusive`：只读 Pi 全局，共享文件和 host 侦测都关掉。
- `/mcp disable <server>` / `enable`：只把 `disabled` 写进项目 `.pi/mcp.json`，**绝不改**共享文件，也绝不把凭据拷过去。改完要 `/reload` 才会刷新已注册的工具表面。

写适配器私有字段（`directTools`、`lifecycle`）时，README 的约定是写到 Pi 自己的文件，不要去改 Cursor 那份共享 json。共享文件负责「这个 server 是谁」；Pi 文件负责「Pi 怎么用它」。

读和写不是同一张地图。共享全局文件的 **写入口** 往往是 `~/.pi/agent/mcp.json`：从 Cursor 进口一份定义之后，适配器私有字段写到 Pi 文件，以免改脏别人的配置。项目共享 `.mcp.json` 则读写同一路径。搞混「我刚 import 进来」和「我改的是哪份文件」，是配置不生效的第二常见原因。

`hostConfigDiscovery` 默认 `off`。`prompt` 只侦测/报告，不把 Cursor 的 server 真正合并进来；`on` 才作为最低层 fallback 加载。CLI `pi-mcp-adapter init --discover-host-configs` 是把这项写成 `on` 的脚手架，不是运行时。

json 里还可以声明 `imports: ["cursor", …]`，显式把某种宿主配置拉进来。这和 discovery 开关是两条路：imports 是这份 Pi 配置自己点名；discovery 是「扫一圈看机器上还有谁」。

Bearer 字面量、`bearerTokenEnv`、命令取 token，优先级高于凭据库里那条。`bearerTokenStore: true` 才走适配器自己的 OS 仓库；仓库不可用或 URL 对不上时 **fail-closed**，不会退回明文。

OAuth 凭据不在这些 json 里。权威是 OS 凭据库，按 server 名绑定 URL。`settings.oauthDir` / `MCP_OAUTH_DIR` 只是旧明文的进口。

## 9. 把最容易混的词钉死

| 词 | 是 | 不是 |
|---|---|---|
| 适配器 | Pi 进程里的 MCP Client | MCP server / 常驻网关 |
| `mcp` 工具 | 模型默认看见的那一把代理 | 某一个具体 MCP server |
| 元数据缓存 | 上次成功连接记下的工具清单 | 活连接；也不是「有哪些 server」的权威 |
| lazy | 启动不连，第一次调用才 spawn/连 | 永远不连 |
| keep-alive | 连上之后保活并在 HTTP 上刷新清单 | 适配器自己变成 daemon |
| directTools | 把部分工具提升到 Pi 一等列表 | 换一种运输；也不跳过审批/OAuth |
| `disabled` | 配置层禁止这个 server | 进程已经死了 |
| socket 运输 | 连别人已经拉起的 mux | 适配器去 start/stop 那个 mux |
| 采样 | server 请宿主跑一次模型补全 | 又一次普通工具调用 |

常见误区：

- **错。** 以为装了扩展，配置里的 `command` 就会在后台一直跑。**正。** 默认 lazy；`/mcp` 能列出 server 只说明配置合并成功。
- **错。** 以为 `mcp({ search })` 失败就是 server 挂了。**正。** 搜索打缓存。没缓存或哈希变了，搜不到也可以是「还没连过」。
- **错。** 以为改 `~/.pi/agent/mcp.json` 一定能盖住项目 `.mcp.json`。**正。** 项目 `.pi/mcp.json` 比它高；项目 `.mcp.json` 也比 Pi 全局高。
- **错。** 以为 Unix socket 模式下子进程挂了适配器会拉起来。**正。** 它不养对面。
- **错。** 以为 direct 工具绕过适配器直连。**正。** 注册表面不同，执行仍走同一条 `executeCall`（连接、审批、OAuth、折回都在）。

## 10. 失败时你能看见什么

症状式，按能观察到的现象排：

**模型根本调不到 `mcp`。** 扩展没装上，或当前 session 的工具表面被关掉。不要先怀疑 MCP server——还没轮到它。

**`/mcp` 看得到 server，一调就 `server_not_connected` / 冷却。** 看 `command` 能不能在配置的 `cwd` 下拉起；看 60 秒冷却；看是不是刚失败过。stdio 的 stderr 尾巴会进连接错误。

**搜得到工具名，一 call 要认证。** 缓存是旧会话留下的；活连接卡在 `needs-auth`。本地交互走 `/mcp-auth`；远端/无 UI 走 `mcp({ action: "auth-start" })` 再把回调 URL 喂回去。URL 对不上凭据库里的绑定，token 不会被拿去用。

**报 `ambiguous_tool`。** 两个 server 规范化后撞了同一个前缀。加 `server` 参数，或改名，不要改运输。

**报 `native_tool`。** 模型把 `read` / `bash` 这类 Pi 内置工具塞进了 `mcp({ tool })`。直接调内置工具。

**工具结果是长文本、details 里却是错误码。** 看 `details.error`，不要只看模型复述。`tool_result` 钩子负责让 Pi 把它当失败，但模型仍可能把文本读成「server 说了句抱歉」。

**eager server 掉了不再回来。** 这是合同：`eager` 不自动重连。要自动回来用 `keep-alive`。

**改了配置 `/mcp` 还是旧清单。** 没 `/reload`。disable 写的是 `.pi/mcp.json`，已注册的工具表面不会自己盯文件。

**keep-alive 的 HTTP server 工具清单和模型看见的对不上。** 看有没有 `freezeDirectTools`；没有的话，清单刷新走的是保活时钟上的 `tools/list`（单次大约 5 秒上限，最多 10 个并行，易变），不是你刚保存的 json。json 只决定「去连谁」。

**别的扩展想复用 OAuth token。** 走公开子路径 `pi-mcp-adapter/oauth` 的 URL 绑定读写，不要 deep-import 私有文件。读路径会先 refresh 再返回。注册密钥、PKCE、OAuth state 不会从这条 API 露出来。

## 11. 如果只记一条主线

可独立验证的稳定事实：

1. 形态是 **Pi 进程内的 MCP Client 扩展**，不是网关，也不是 MCP server。
2. 默认工具表面是 **一把代理**；MCP 进程默认 **lazy**，第一次真正调用才出现。
3. **配置合并结果**决定有哪些 server；**缓存**决定没连接时能搜到什么；**活 server** 决定这次调用的结果。三者不是同一个权威。
4. stdio 的父进程是 Pi；HTTP 的对面是远程服务；socket 的对面 **不归** 适配器养。
5. direct / 命名空间只换模型看见的脸，执行仍汇进同一条调用链。

如果只记一条完整主线，可以记成：

```text
多份 mcp.json 合并出「有哪些 server」
  → 扩展在 Pi 进程里注册一把 mcp（以及可选的 direct / 命名空间）
  → 模型搜缓存或直接点名
  → 第一次调用才在宿主里 connect（spawn / HTTP / socket）
  → 对面 MCP 进程做事
  → 结果折回 Pi；会话结束则拆 Client 侧
```

改工具表面、改生命周期、改合并顺序，都绕不开这条线。协议方法名会变，这条线不应变。

## 12. 想改代码时按这个顺序读

1. `index.ts`：扩展怎么挂上、`session_start` / 加载期 init / `session_shutdown`、`mcp` 工具把哪些参数派发出去。看了能懂「宿主看见的那张脸」。
2. `config.ts`：`loadMcpConfig`、`getConfigSources`、`mergeServerMaps`（含换 URL 丢凭据）。看了能懂权威源，不必先猜文件。
3. `init.ts`：缓存重建、eager 启动、`lazyConnect`、闲置超时怎么落到每个 server。看了能懂「启动完成 ≠ 进程在」。
4. `lifecycle.ts`：keep-alive 收敛、闲置关闭、重试时钟。看了能懂四种 lifecycle 在运行时的差别。
5. `server-manager.ts` 的 `connect`：三种运输互斥、stdio spawn、连上之后拉清单。看了能懂进程边界。
6. `proxy-modes.ts` 的 `executeCall`：解析名字 → 门禁 → connect → RPC → 折回。这是一次调用的合同。
7. `direct-tools.ts` + `namespace-tools.ts`：另外两张脸怎样仍调用 `executeCall`。
8. `metadata-cache.ts`：哈希吃哪些字段、7 天过期、路径。看了能懂搜索为什么不连进程。
9. `runtime-owner.ts`：会话级 abort 与清理。reload / shutdown 竞态从这里看。
10. `__tests__/proxy-modes-discovery.test.ts` 与 `__tests__/config.test.ts`：名字消歧和合并顺序的行为合同。

本地冒烟：`pi install npm:pi-mcp-adapter`（或指向本目录），放一个最小 stdio server 进 `.pi/mcp.json`，`/reload`，先 `mcp({ search: "..." })` 确认缓存/配置层，再真正 `mcp({ tool, args })` 看状态栏出现 `connecting to …`。搜得到但 connecting 从未出现，说明还停在缓存层。

再补两刀：`/mcp disable` 那个 server 之后 `/reload`，搜索应把它排除，共享 json 不应被改；把 `lifecycle` 改成 `keep-alive` 再 reload，会话一开始就该看到子进程，而不必先 call。

## 参考资料

- [pi-mcp-adapter README](https://github.com/nicobailon/pi-mcp-adapter)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [What if you don't need MCP?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
