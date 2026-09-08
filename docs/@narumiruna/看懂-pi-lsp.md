# 看懂 pi-lsp：按需拉起语言服务器，用完就关

> 本文面向已经知道「LSP 是编辑器跟语言服务器说话的协议」的读者。不要求写过语言服务器，但需要把 Pi 理解成会调工具的编码 Agent，而不是 IDE。
>
> 源码基线：`@narumitw/pi-lsp` **v0.49.6**（本仓库 `@narumiruna/pi-lsp`）。默认服务器名单、超时和配置文件名易变；稳定认知放在「谁在何时拥有语言服务器进程」和「诊断与写入的边界」上。
>
> 官方说明：[README](../../@narumiruna/pi-lsp/README.md) · [npm](https://www.npmjs.com/package/@narumitw/pi-lsp)

本文定位：小/轻量，二次开发深度。

## 1. TLDR：它到底是什么

pi-lsp 把 Language Server Protocol 收成两个模型工具。一次诊断可以压成：

```text
模型调用 lsp_diagnostics
→ 按扩展名路由到配置里的 server
→ 本轮临时 spawn 语言服务器
→ initialize / didOpen / 等诊断稳定
→ 把结果还给模型
→ shutdown（进程结束）
```

所以它不是：

- 不是 IDE，不会在你打字时常驻一个 language server；
- 不是把 Biome/Ruff 的 CLI 再包一层——它走的是 LSP 会话，不是 `ruff check` 那种一次性命令；
- 不是项目级守护进程。工具返回后，服务器进程就该没了；
- 不是「装了扩展就自动有诊断」。没装对应命令（如 `gopls`），那条路由只会失败或跳过。

正面定义：**按文件扩展名路由的、短生命周期的 LSP 客户端。** 判断「要不要查、查哪些文件、修复要不要写盘」的是宿主 Agent；扩展负责安全地找到文件、说 LSP、关进程。

权威输入是 **配置里的 server 命令 + 工作区里的真实文件内容**。工具返回的诊断是这一次会话的快照，不是持续索引。

## 2. 为什么 Agent 不能直接当编辑器插件用

编辑器里的 LSP 客户端会一直开着：文件一改就 `didChange`，诊断推送到问题面板。Agent 的工作方式相反：它偶尔对一批文件提问，然后继续改代码。

如果按 IDE 的方式常驻 server：

- 扩展要在 Pi 的整个会话里管一堆子进程；
- 文件被 `edit` 工具改过之后，server 内存里的版本很容易和磁盘不一致；
- 用户关掉 Pi 时还得处理没 shutdown 的 server。

所以 pi-lsp 选了另一条路：**每次工具调用开一轮事务，读磁盘上的当前文件，用完就关。** 代价是没有增量分析、每次都有启动开销；收益是所有权清晰，失败时不会留下幽灵进程（`finally` 里 shutdown）。

该用：改完代码后做定向验证，或让模型在写入前预览 `source.fixAll`。

不该用：想替代 `tsc --noEmit` 的全量 CI，或假设「刚才的诊断还在后台刷新」。

## 3. 先看整体架构，不急着看类名

```text
Pi 宿主
 └─ pi-lsp.ts（胶水：注册 /lsp、两个工具、session 事件）
     ├─ adapters.ts   配置 → 规范化的 server 适配器
     ├─ routes.ts     用户意图 → 选哪些 server、哪些文件
     ├─ files.ts      路径必须落在 workspace，收集有上限
     ├─ runner.ts     一次诊断/修复的事务
     ├─ lsp-client.ts stdio JSON-RPC
     └─ text-edits.ts LSP 坐标 → 文件文本
```

| 层 | 收到什么 | 做什么 | 产出什么 |
|---|---|---|---|
| 胶水 | 工具参数 / `/lsp` | 解析 root、加载配置、套 status | 调用 runner |
| 配置 | `pi-lsp.json` 或内置默认 | 按扩展名和命令做成 adapter | 可 spawn 的 server 列表 |
| 路由 | 路径、可选 server 名 | 选出匹配的 adapter 和文件 | 有界文件集 |
| 事务 | adapter + 文件 | 开进程、说话、关进程 | 诊断或预览/写入结果 |
| 协议 | LSP 消息 | Content-Length framing、request id | diagnostics / code actions |
| 编辑 | workspace edit | 拒绝重叠/越界，可选写盘 | 新文件内容 |

图纸上的「LSP 服务」是协议角色。进程真相是：**语言服务器只在 runner 的 try/finally 里活着**，不等于一台一直监听的诊断服务。

## 4. 实际怎样运行：扩展在 Pi 里，语言服务器是工具调用的孩子

证据：`pi.extensions: ["./dist/index.ts"]`，`src/index.ts` 转发 `pi-lsp.ts`。命令是 `/lsp`（展示当前配置），工具是 `lsp_diagnostics` 和 `lsp_fix`。

装了什么：npm 包本身。真正干活的二进制（`biome`、`gopls`、`rust-analyzer`…）要在 PATH 上，或在配置里写绝对命令。配置搜索顺序：

1. 受信任项目下的 `.pi/pi-lsp.json`（旧名 `.pi/lsp.json` 仅兼容，不会自动改名）；
2. 否则用户 Agent 目录的 `pi-lsp.json`；
3. 再没有，就用内置默认名单（biome、ruff、gopls 等）。名单上缺命令的**默认** server 会被跳过，不会让整次诊断失败；你在参数里点名的 server 缺命令才会抛错。扩展不负责安装这些二进制。

有没有常驻进程：**扩展自己没有。** 每次 `runDiagnostics` / `runFix` 都会 `new LspClient` → `start` → `finally shutdown`。`session_start` 只预读配置并可能弹出警告，不预热 server。

和宿主的关系：

```text
Pi 宿主进程
 └─ 本扩展（路由 + JSON-RPC 客户端）
     └─ 子进程：某个 language server（stdio）
         工具开始时 spawn，工具结束时 shutdown
```

谁拉起归谁：工具 `execute` 拉起，abort signal 会 `client.close()`，`finally` 再 shutdown。不要把 status 栏里短暂出现的 `gopls diagnostics` 理解成后台守护。

## 5. 一条真实输入：对刚改过的文件要诊断

```text
lsp_diagnostics({ paths: ["src/app.ts"] })
→ 解析 workspace root
→ 按 .ts 匹配 server（可能多个）
→ 每个 server：spawn → initialize → didOpen → 等诊断
→ 合并文本结果还给模型
→ 每个 server shutdown
```

### 5.1 胶水层：参数先变成一次路由

`paths` 缺省则从 workspace root 按扩展名收集，默认最多 50 个文件。`root` 必须能落成合法工作区。`server` 可覆盖为单个或一组已配置名字。

这一步同步、纯代码，还没有子进程。

### 5.2 文件层：路径不可信

`files.ts` 要求路径留在 root 内，realpath 去重，跳过 `node_modules` 一类目录。这是安全边界，不是性能优化。收集超限就停，避免一次把整个仓库喂给 server。

### 5.3 事务层：一个 adapter 一轮生命周期

`runner.ts` 对每个匹配的 server 单独开客户端。先 `start`（spawn 配置里的 command），再 `initialize`，然后对每个文件读**磁盘当前内容**做 `didOpen`。诊断稳定后格式化返回。`finally` 里 `didClose` + `shutdown`，status 清掉。

同步从调用方看是一次工具等待；内部是异步 JSON-RPC。失败时原文件不变——诊断路径本来就不写盘。

### 5.4 修复链路多两步，写盘是显式开关

`lsp_fix` 默认 `kind = source.fixAll`。拿到 code actions 后，把 workspace edit 收成文本编辑；重叠或非法坐标直接拒绝。`write: false`（默认）只预览；`write: true` 才落盘。

完成 ≠ 项目已干净：这一次 server 对这一批打开文件的视图，不等于 CI 全量通过，也不等于 IDE 里持续诊断的最终态。

## 6. 边界、误区和排错

| 词 | 是 | 不是 |
|---|---|---|
| adapter | 一条「名字 + 命令 + 扩展名」配置 | 常驻 server 句柄 |
| 默认服务器名单 | 没写配置时的起点 | 保证本机已安装 |
| `lsp_fix` | 一次 source action | 任意重构 |
| 项目 `pi-lsp.json` | 受信任仓库才读 | 不可信项目里的任意可执行文件来源 |

常见误区：

- 「装着 pi-lsp，TypeScript 就会一直提示。」错。正：只有模型（或你让它）调用工具的那几秒才有 server。
- 「诊断为空就是代码没问题。」错。正：可能是扩展名没匹配、命令不存在、文件收集为 0、超时或 server 还没发布诊断。
- 「`write: true` 等于安全自动修。」错。正：只应用这次返回的 edit；重叠 edit 会被拒绝，这是当前正确性边界。

症状式排错：

- **资源能打开，但语义诊断没有**：先 `/lsp` 看哪些命令在 PATH 上（这不表示 server 活着），再确认扩展名是否匹配。默认名单缺命令是跳过，不是报错。不要先怀疑 JSON-RPC framing。
- **修复预览有、写入后更坏**：先看是不是多个 server 抢同一文件、edit 是否按 LSP 行列坐标应用。不要先改 `lsp-client.ts`。
- **工具被取消后还占着 cpu**：查 `runner.ts` 的 abort 监听和 `finally shutdown`。正常路径必须能杀掉孩子。

当前可靠性边界：没有跨 server 的总事务。两个 server 都诊断同一文件时，结果是拼接快照；修复一次只走选中的那条路由。

## 7. 总结

1. 它是 Pi 扩展里的短生命周期 LSP 客户端，不是 IDE 插件，也不是常驻诊断服务。
2. 权威输入是配置命令 + 磁盘文件；每次调用都重新 `didOpen`。
3. 诊断不写盘；修复默认预览，显式 `write` 才落盘。
4. 项目配置只在受信任仓库读取，避免把仓库里的可执行文件当 server。

如果只记一条主线：

```text
工具调用 → 路由 adapter → spawn LSP → didOpen 当前磁盘 → 取诊断/action → shutdown
```

## 8. 深入通道：源码阅读顺序

1. `src/index.ts` — 入口转发。
2. `src/pi-lsp.ts` — 两个工具和 `/lsp` 怎么接到 runner。
3. `src/adapters.ts` — 配置搜索顺序、默认服务器、规范化。看了能懂「命令从哪来」。
4. `src/routes.ts` — 诊断可多 server，修复为什么是单路由。
5. `src/files.ts` — workspace 边界和收集上限。
6. `src/runner.ts` — 事务和 shutdown 不变量。
7. `src/lsp-client.ts` — framing、request id、等待 diagnostics。
8. `src/text-edits.ts` — LSP 坐标不是 JS offset。
9. `test/lsp.test.ts`、`test/lsp-client.test.ts` — 超时、清理、修复合同。

二次开发先改 adapter 配置和 files 边界，再动 JSON-RPC。协议层的 id/超时写错，会把「偶发挂起」带进每一次工具调用。
