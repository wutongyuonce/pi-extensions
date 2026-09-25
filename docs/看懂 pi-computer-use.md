# 看懂 pi-computer-use：Pi 进程只编排，真正碰桌面的是另一条 native helper

> 本文面向已经会用 Pi、知道扩展会注册工具的读者。重点不是 AX/UIA 字段名，而是讲清：工具调用发生在哪个进程、谁去点屏幕、`stateId` 为什么不能跨观察复用、关 Pi 之后 helper 还在不在。macOS / Windows / Linux 的 helper **形态不一样**，不要用其中一个想象另外两个。
>
> **本文定位：中项目、二次开发深度。** 稳定认知放在「宿主 TypeScript ↔ native helper ↔ 可选 CDP」三条进程边界、不可变观察、按物理资源串行。协议版本号、默认超时、overlay 动画属于易变细节。旧工具名 `screenshot` / `click` / `computer_actions` **已经不在**公开表面上。
>
> 源码基线：本仓库 `pi-computer-use`，包 `@injaneity/pi-computer-use` `0.5.1`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13ed69a55f94889194018f652adf628ddc4b`（2026-09-03）。上游：[injaneity/pi-computer-use](https://github.com/injaneity/pi-computer-use)。入口：`package.json` → `pi.extensions = ["./extensions"]` → `extensions/computer-use.ts`。macOS helper 要求 14+。

## 1. TLDR：Agent 看到的是工具，机器上跑的是两（或三）个进程

```text
Pi 宿主进程（Node，加载扩展）
    │  注册 find_roots / observe_ui / act_ui / …
    │  保存不可变观察（stateId、@e、epoch）
    │  按 desktop-pid:N 或 cdp:page 排队
    │
    ├─ JSON 行协议 ──► native helper（OS 辅助功能 + 截图 + 输入）
    │                     macOS: 独立 .app + Unix socket，默认可活过 Pi
    │                     Windows / Linux: Pi 的子进程，stdin/stdout，会话结束就杀
    │
    └─ Chrome DevTools Protocol ──► 托管浏览器（可选）
                          不经过 native helper；loopback 端口
```

所以它**不是**：

- 不是「Pi 自己变成了辅助功能客户端」。Node 进程不直接打 AX/UIA/AT-SPI。
- 不是截图再让模型猜坐标的开环。公开面上先观察出带 ref 的树，再 `act_ui`；纯图片点被 UI-tree-only 策略挡住。
- 不是 MCP server，也不是系统级 computer-use daemon（launchd/Windows 服务）。谁开 Pi 谁用；安装脚本只把 helper 二进制放到用户目录。
- 不是跨 OS 同一套输入。Linux Wayland 语义为主；X11 才有守卫下的 XTEST；macOS 要 TCC。
- 不是「`headless: true` = Chrome --headless」。配置里的 headless 是**桌面输入投递策略**（后台/不抢焦点），浏览器另说。

正面定义：**同一套 state-scoped 工具合同，下面接三个 native helper + 一条可选 CDP；观察不可变，动作按物理资源串行。**

## 2. 为什么必须把 helper 拆出 Pi 进程

正例：要点 Safari 里的按钮。辅助功能 API、ScreenCaptureKit、CGEvent 都要求一个**有 GUI 身份的进程**拿 TCC 授权。把这些能力塞进 `pi` CLI，授权会记到 Terminal / Electron / 谁启动 Pi 谁头上，升级一次签名就全失效。所以 macOS 做成 `pi-computer-use.app`（bundle id `com.injaneity.pi-computer-use`），设置里授权给这个 app，不给 Pi。

反例：Windows 上若也做成常驻 .app 式服务，会话桌面、UIA 和 Pi 生命周期会对不齐。这里选择 **Pi 拉起的 stdin/stdout 子进程**，会话结束 `dispose()` 杀掉。Linux 同款：必须跟当前图形会话的 AT-SPI 总线在同一用户里，SSH/`sudo` 带不过去。

四行职责：

| 谁 | 管什么 |
| -- | ------ |
| 扩展 TS（`bridge.ts`） | 工具合同、stateId、epoch、排队、把结果折成给模型看的大纲 |
| native helper | 列窗口、走辅助功能树、截图、点按/输入、权限探针 |
| CDP 客户端（`cdp.ts`） | 浏览器页面的树和导航；与桌面 helper 无关 |
| OS 权限/总线 | 能不能看、能不能点；TS 再怎么编排也越不过去 |

## 3. 先看整体架构，不急着看类名

文档视角（官方 `docs/architecture.md` 的合同）：

```text
find_roots          得到 @r（窗口 / 菜单 / sheet / 浏览器页）
    ↓
observe_ui 一个 @r  得到 stateId + 折叠大纲；完整树进缓存
    ↓
search / expand / inspect   查缓存，默认不再打 OS
    ↓
act_ui(stateId, steps)      校验 epoch → helper 执行 → 再观察 → 存后继状态
```

进程真相：上面每一步「打 OS」都是 **TS 发一行 JSON，helper 回一行 JSON**。`search_ui` 若只查已缓存的树，连 helper 都不叫。并发时，同一 `desktop-pid:123` 上的 observe/act 会排队；不同 pid、不同 CDP page 可以并行。全局物理鼠标在 helper 里还有互斥，语义 AX 工作允许重叠。

没有「当前窗口」全局变量。每次工具调用从 `stateId` 水合出**请求局部**状态（`AsyncLocalStorage`）。别的工具调用改不了你手里的这棵树；树要么还在（最多 128 份），要么被挤掉后 ref 清晰失败。

权威源：

- **这一眼 UI 长什么样**：那次 observe 存下来的不可变记录（不是屏幕现在的像素）。
- **能不能写**：该资源当前 epoch；过期的 `act_ui` 在 dispatch 前就被拒。
- **窗口还在不在**：下一次 `find_roots` / helper 的 listRoots，不是 TS 里的 @r 表。

配置权威更弱：`~/.pi/agent/extensions/pi-computer-use.json` → 项目 `.pi/computer-use.json` → 环境变量，后者覆盖前者。`/computer-use` 只打印这份合成结果从哪来。

## 4. 运行形态：宿主编排进程 vs native helper

### 4.1 宿主（Pi 进程）

`extensions/computer-use.ts` 默认导出：

- 注册一排工具（桌面八件套 + `launch_browser` / `navigate_browser` / `evaluate_browser`）；
- `/computer-use` 命令：通知配置，不启动 helper；
- `session_start`：读配置、从 git 分支尝试重建状态；**仅 `ctx.hasUI` 时**跑 `ensureComputerUseSetup`（装 helper、查权限）。无 UI 的 headless 会话不会弹 TCC 向导；
- `session_shutdown`：关掉资源调度器、断开 CDP、SIGTERM 托管浏览器、清空观察；然后 `currentPlatformBackend.shutdown?.()`。

工厂加载了 ≠ helper 在跑。第一次真正 `ensureReady` / 第一次工具走到平台层，才会装、连、握手协议版本。

`postinstall` 跑 `scripts/setup-helper.mjs --postinstall`：从 `prebuilt/` 或 GitHub release 把对应 OS 的 helper 拷到用户路径。这是安装期，不是运行期常驻。

### 4.2 macOS helper：独立 app + socket，默认可活过 Pi

| 项 | 事实 |
| -- | ---- |
| 形态 | `pi-computer-use.app`，可执行文件 `Contents/MacOS/bridge`（Swift） |
| 默认路径 | 已有可写的 `/Applications/...` 就沿用，否则 `~/Applications/pi-computer-use.app` |
| 覆盖 | `PI_COMPUTER_USE_HELPER_APP_PATH` |
| 通信 | Unix socket，默认 `~/Library/Caches/pi-computer-use/bridge.sock`（`PI_CU_SOCKET_PATH`） |
| 拉起 | `open -n -g <app> --args serve --socket <path>` |
| 协议 | 一行 JSON，`HELPER_PROTOCOL_VERSION = 6` |
| 权限 | Accessibility + Screen Recording，必须授给 **helper app**，不是 Terminal |
| 会话结束 | macOS backend **没有** `shutdown()`。注释写明 daemon **outlives Pi**；reload Pi 不会自动换掉旧 daemon。协议/可执行路径对不上才会 `restart`（先发 `shutdown` 命令再 relaunch） |

所以在 Mac 上「关了 Pi」≠「辅助功能进程没了」。残留的旧版本 helper 会让下一次握手炸掉，这是设计过的，不是泄漏。

### 4.3 Windows helper：Pi 的子进程

| 项 | 事实 |
| -- | ---- |
| 形态 | Rust `windows-bridge.exe`（UIA + 输入） |
| 默认路径 | `~/.pi/agent/helpers/pi-computer-use/windows-bridge.exe` |
| 覆盖 | `PI_COMPUTER_USE_WINDOWS_HELPER_PATH` |
| 通信 | 子进程 stdin/stdout，JSON 行，带 `protocolVersion` |
| 协议 | `4` |
| 拉起 | 第一次 `command()` 时 `spawn(exe, [], {stdio: pipe})` |
| 会话结束 | `windowsHelper.dispose()` 杀掉子进程 |

要交互式桌面会话。没有 macOS 那套 TCC 向导。

### 4.4 Linux helper：也是子进程，能力跟着显示服务器变

| 项 | 事实 |
| -- | ---- |
| 形态 | Rust `linux-bridge` |
| 默认路径 | `~/.pi/agent/helpers/pi-computer-use/linux-bridge` |
| 覆盖 | `PI_COMPUTER_USE_LINUX_HELPER_PATH` |
| 通信 / 协议 | 与 Windows 同构，版本 `4` |
| 会话结束 | `linuxHelper.dispose()` |
| 前置 | 同一用户、同一图形会话、AT-SPI2 总线可用 |

能力矩阵（`docs/linux.md`，稳定方向）：

- 发现/观察：AT-SPI 语义；X11 可用 EWMH 补几何和焦点。
- 截图 / 物理输入：X11 上有，且受 headless/background 策略闸门；Wayland 语义-only，portal 只读诊断，不建会话。
- 严格 headless 永不 focus、永不 XTEST。

容器、systemd user 服务、`sudo`、另一条 SSH，都没有这份总线。

### 4.5 第三进程：托管浏览器

`launch_browser` 在宿主里 `spawn(chrome|helium)`，临时 profile + remote debugging port。CDP 走 loopback，**不经 helper**。`session_shutdown` 会对托管浏览器 SIGTERM。桌面 Chrome 窗口仍可能出现在 `find_roots` 里，那是 helper 看见的 AX 树，和 CDP page `@r` 不是同一个根。

Mac 上还有一个容易误会的东西：`cursor_overlay`（默认 true）。光标动画画在 **helper 进程里的 click-through overlay**，helper 列根时会把自己排除掉。它是观察性的：新动作可以打断还在飞的轨迹，渲染**不阻塞**投递和校验。没有公开的「移动鼠标光标」工具；坐标最终落点由 native grounding 说了算，所以 overlay 不能拆到第二个进程，否则还得再做一次坐标变换。

## 5. 变体：同一合同，三套手

`platformBackendForRuntime(process.platform)` 选出 macos / windows / linux，其它平台直接 throw。TS 侧工具名字不变，native 源码分家：

```text
native/macos/bridge.swift          + agent_cursor*.swift
native/windows/bridge-rs/          Cargo 工程
native/linux/bridge-rs/            Cargo 工程
prebuilt/{macos,windows,linux}/    安装时拷走
```

二次开发改「怎么点」去 native；改「何时点、如何对模型撒谎更少」去 `bridge.ts` / `actions.ts` / `view.ts`。

## 6. 纵向链路一：看一眼窗口（观察）

```text
1. 工具层     find_roots / observe_ui          宿主，同步进入 execute
2. 就绪层     ensureReady：装 helper、握手、权限   可能异步弹 TUI 向导
3. 调度层     ResourceScheduler 按 desktop-pid 排队
4. helper     listRoots / observe JSON 命令      出进程
5. 保存层     StateStore.create → stateId + epoch
6. 视图层     折叠大纲返回模型；完整树留在宿主内存
```

完成 ≠ 就绪：

- `find_roots` 返回 `@r` ≠ 这扇窗还活着。@r 是本会话的稳定句柄，窗关了下次 observe 会失败。
- `observe_ui` 返回了大纲 ≠ 屏幕还是那样。那是一份不可变快照。
- `search_ui` 命中 ≠ helper 刚扫过。默认读缓存；OCR 升级才再进调度器，且要过 epoch。
- setup 向导点完 Recheck ≠ Screen Recording 真能截。macOS 以 helper 的 **ScreenCaptureKit 探针**为准，TCC 数据库显示已授权但探针失败，会当成「授权记在别的身份上」。

`observe_ui` 的 mode：`semantic` 跳过 OCR/图，`visual` 强制，`fused` 默认自动。pictureOnly 的坐标 ref 不能拿去 `act_ui`（UI-tree-only）。

`session_start` 会 `reconstructStateFromBranch`：从当前聊天树里倒着扫 `toolResult`，把 `find_roots` 留下的 `@r` / pid / 几何拼回去。这恢复的是**句柄表**，不是 128 份完整观察树。新会话里旧 `@e` 仍然作废；最多让模型继续用昨天的 `@r3` 去再 observe 一次。Windows 侧更狠：TS backend 基本是无状态转发，真正的 look 树（含 `lookId`）活在 helper 进程里——Pi 一 `dispose`，那些 look 也没了。

给模型的文本有界（`output.ts`）：预览大约 16KB / 行数上限，全文进临时页，可用 `read_text` 翻。辅助功能树可以很大，合同是「先看折叠大纲」，不是把 HWND 森林整棵塞进 context。

## 7. 纵向链路二：点一下、打几个字（动作）

```text
1. 模型给出 act_ui({ stateId, actions: [...] })
2. 宿主用 stateId 取出那棵树和 epoch
3. actions.ts 规范化、解析 @e、补上依赖焦点（点完接着 type 不丢焦点）
4. epoch 对不上 → StaleResourceStateError，helper 不会动
5. 对上 → 一条或一批 JSON 给 helper（act / actBatch）
6. helper 投递并做它能做的送达校验
7. 宿主再 observe，存后继 state，返回紧凑 diff（身份够自信时）
```

`act_ui` 接受一步或多步。多步是**同一资源上的事务**，不是多个窗口并行点。失败会走安全恢复，不把半截按键留在前台（能恢复的前提下）。

投递策略（易变名字，稳定的是三档）：

- 默认 / foreground：可以抢焦点、物理输入（macOS HID 等）；
- background / `headless: true`：尽量 pid 定向、不抢前台；Linux 上直接关掉 XTEST 和 focus；
- ax_only：只走辅助功能动作。

策略过严时「看见按钮却点不了」是合同，不是 helper 死了。

## 8. 纵向链路三：浏览器页（CDP，旁路 helper）

```text
launch_browser → 宿主 spawn Chromium 家族 → 记下 loopback 端口
navigate_browser / observe_ui(kind=browser_page) → cdp.ts
evaluate_browser → Runtime.evaluate，输出有界
```

浏览器根会出现在 `find_roots` 的森林里，和桌面窗口并列。观察仍变成同一套 outline。调度键是 CDP target，不是 pid。

`browser_use: false` 时这条旁路关掉。CDP 连上本地调试端口 = 对那个 profile 有很大权力；托管启动用**全新临时 profile**，不用你日常登录的那个。手动开的 Chrome 必须自己带非默认 `--user-data-dir` 和 `--remote-debugging-port`。

## 9. 边界、误区、失败形态

**Pi 活着 ≠ helper 协议匹配。** 升级扩展后 Mac 上旧 daemon 还占着 socket，必须靠握手失败后的 relaunch。Windows/Linux 每次会话新子进程，反而更不容易留旧协议，但 `~/.pi/agent/helpers/...` 里的二进制可能还是上一版——protocol mismatch 文案叫你 Restart Pi，其实要的是**已安装的那份 helper**和 TS 期望的版本一致。

**授权给 Pi ≠ 授权给 helper。** macOS 设置里要找 `pi-computer-use.app`。重签名会作废旧开关，需要关再开。

**semantic observe 成功 ≠ 能截图。** 树走辅助功能，图走 Screen Recording / XComposite。可以只看见按钮名字、看不到像素。

误区 1：「这是截图模型。」——公开工具是树 + ref；截图是观察的可选证据。

误区 2：「Linux 和 Mac 一样点屏幕。」——Wayland 没有这条物理路径。

误区 3：「关 Pi 会卸掉 Mac 的辅助功能进程。」——默认不会。

误区 4：「`stateId` 可以留给明天用。」——会话关了 `savedStates.clear()`；同一会话也可能被 128 上限挤掉。

误区 5：「两个 Agent 同时点两个 App 会互相阻塞。」——不同 pid 不共享调度车道；同一 App 内会串行。物理鼠标仍可能全局互斥。

误区 6：「`docs/windows-bridge.md` 写协议 3，所以源码也是 3。」——Windows/Linux TS 常量是 `4`，macOS 是 `6`。安装文档会落后，握手以 helper 回的 `protocolVersion` 和 TS 常量为准。

| 现象 | 先查哪一层 |
| ---- | ---------- |
| 无 UI 会话里工具失败，说要 interactive | `session_start` 跳过了 setup；headless 没有向导 |
| Mac 权限开关是绿的仍截不了 | 探针 vs TCC 行；签名迁移；授权是否记在 Terminal 上 |
| protocol mismatch | helper 二进制/残留 daemon 和 TS 常量（mac 6 / 其它 4） |
| State is stale | 两次 act 抢同一 pid，第二次该重 observe |
| Linux AT-SPI unavailable | 不在图形会话里，或无障碍总线没起 |
| Wayland 能搜到按钮 act 失败 | 能力矩阵，不是 bug 票 |
| 浏览器工具没反应 | `browser_use`、CDP 端口、是否托管 profile |
| `/computer-use` 只弹配置 | 它本来就不是 start 命令 |

## 10. 总结：五件能核对的事 + 一条主线

1. 扩展在 Pi 进程里只编排；桌面 I/O 在 native helper；浏览器 I/O 在 CDP。三套进程，一种工具合同。
2. macOS helper 是独立 `.app` + socket，**默认活过 Pi**；Windows/Linux helper 是会话子进程，shutdown 就杀。
3. 观察是不可变、带 epoch 的；`@e` 只在产生它的 `stateId` 里有效；缓存查询不打 OS。
4. 实时动作按物理资源串行（桌面按 pid，浏览器按 page），跨资源可并行。
5. `headless` / background 是输入策略，不是「没显示器的服务器也能点 Wayland」。

```text
Agent 工具
    →  Pi 宿主（state / epoch / 调度）
         ├─ socket/stdio JSON  →  OS helper → 窗口
         └─ CDP                →  托管浏览器
```

## 11. 深入通道：源码阅读顺序

1. `extensions/computer-use.ts`。看了能懂公开工具面、`hasUI` 才 setup、shutdown 清什么。
2. `src/platform/index.ts` + `macos/helper.ts` + `windows/helper.ts` + `linux/helper.ts`。看了能懂三种 helper 的路径、协议、谁是子进程、谁是 socket daemon。
3. `src/platform/macos/helper-path.mjs`、`permissions.ts`、`scripts/setup-helper.mjs` 开头。看了能懂安装到哪、TCC 记在谁头上。
4. `src/runtime.ts`（StateStore + ResourceScheduler）、`src/state.ts`。看了能懂 128 上限、epoch、请求局部状态。
5. `src/bridge.ts` 的 `executeFind` / `executeObserve` / `executeAct` / `shutdownComputerUseSession`。看了能懂工具如何落到调度器和 helper。不必一次读完两千行。
6. `src/actions.ts`、`src/view.ts`、`src/outline.ts`。看了能懂依赖焦点、折叠大纲、ref 归属。
7. `src/cdp.ts`、`src/config.ts`。看了能懂浏览器旁路和 headless 真正改的是哪位。
8. `docs/linux.md`、`docs/windows-bridge.md`、`native/` 下各 OS 目录。改 OS 行为从这里进，不要从 TS 猜键码。
9. `scripts/check-lifecycle.mjs`、`check-runtime-concurrency.mjs`、`check-invariants.mjs`。行为合同：会话清理、跨资源并行、过期写入。

本地冒烟：`pi install npm:@injaneity/pi-computer-use`，TUI 里走完权限，`/computer-use` 能打印配置来源。`find_roots` 应列出本机窗口；关掉 Pi 后，Mac 上 `bridge.sock` 可能仍在、Windows/Linux 的 helper 进程应消失。

## 参考资料

- [pi-computer-use README](https://github.com/injaneity/pi-computer-use)
- 仓库内：`pi-computer-use/docs/architecture.md`、`usage.md`、`linux.md`、`troubleshooting.md`
- [Wait, what exactly is Computer Use?](https://zanechee.dev/what-exactly-is-computer-use/)
- [AT-SPI2 开发指南](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/index.html)
- [Chrome remote debugging 与非默认 profile](https://developer.chrome.com/blog/remote-debugging-port)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
