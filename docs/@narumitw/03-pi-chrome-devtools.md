# pi-chrome-devtools：CDP 的连接管理、安全文件写入与工具层

## 主线

工具第一次需要浏览器时，先尝试已有 DevTools endpoint；仅在本地、可启动错误且允许 auto-launch 时，发现 Chrome/Chromium/Brave/Edge，创建隔离 profile，以动态端口启动并轮询 `DevToolsActivePort`。随后 REST 列 tab、WebSocket CDP 执行命令。截图另走一条严格路径：只允许 cwd 或临时目录，逐级拒绝 symlink/`..`/非常规文件，再原子替换。

## 模块分层

| 文件（行） | 定位与逐段职责 | 关键函数 |
| --- | --- | --- |
| `src/chrome-devtools.ts:1-178` | composition root：注册 tools 和 `/chrome-devtools`，启动恢复工具选择，关闭时只清理本扩展启动的浏览器。 | `chromeDevtools`、`handleChromeDevtoolsCommand`、`parseCommand` |
| `src/tools.ts:1-189` | 五个模型工具与 TypeBox schema；active page id 存在 `runtime.state`，各操作用 `withStatus` 包裹。 | `listPagesTool`、`selectPageTool`、`navigateTool`、`evaluateTool`、`screenshotTool` |
| `src/runtime.ts:1-85` | 默认 host/port/超时和共享运行时类型；`state` 保存 active page、managed process、launch attempt。 | `parseConfiguredPort`、`state` |
| `src/browser-manager.ts:33-294` | endpoint-first、必要时管理浏览器生命周期；轮询和可取消性防止启动竞态。 | `ensureDevToolsEndpoint`、`launchManagedBrowser`、`shutdownManagedBrowser`、`withEndpointRetry` |
| `src/browser-manager.ts:367-649` | 配置提示、host 安全判断、跨平台候选浏览器发现和 PATH 解析。 | `isLocalDevToolsHost`、`browserCandidateDefinitions`、`resolveBrowserCandidates` |
| `src/cdp-client.ts:22-131` | REST `/json` 页面发现、默认页回退、创建 tab 和 result 构造；`withCdp` 管理连接关闭。 | `listPages`、`resolvePage`、`resolvePageForNavigation`、`createPage`、`withCdp` |
| `src/cdp-client.ts:133-219` | WebSocket JSON-RPC 小客户端：递增 id、pending map、每次请求 timeout、socket close 时拒绝全部 waiter。 | `CdpClient.connect/send/close` |
| `src/screenshot.ts:27-244` | 高风险写文件边界；解析目标、校验真实父目录、临时写入再 rename，支持 abort。 | `saveScreenshot`、`resolveScreenshotPath`、`ensureSafeScreenshotParent`、`replaceScreenshotFile` |
| `src/settings.ts:28-196`、`tool-selector.ts:45-340` | 旧设置迁移、白名单验证、当前选择与 Pi active tools 同步、TUI/文本 selector。 | `loadSettings`、`normalizeChromeDevtoolsSettings`、`applyChromeDevtoolsTools` |
| `src/render.ts:19-111` | 为 Pi 产出可折叠的简洁结果；不把巨量 CDP 输出塞进默认视图。 | `renderTextResult`、`renderScreenshotResult`、`withStatus` |

## 从零实现的顺序

先实现 `list_pages`（HTTP 读取 `/json`），再实现 `evaluate`（WebSocket request/response），然后加页选择和导航；浏览器 auto-launch、工具选择和截图安全性是第二阶段。不要将远端 endpoint 当成本地 endpoint：auto-launch 只能针对本地 host，shutdown 只能杀自己创建的 process。

## 安全审查清单

- 每一个 socket request 是否在 response、timeout、close 三种路径都清理 `pending`？
- 用户传入的 `savePath` 是否经 realpath 检查，而非仅字符串 `startsWith`？
- 浏览器启动失败时，错误是否包含 endpoint/手工启动提示而不泄露无关数据？
- 所有 tool 是否从 `state.activePageId` 的陈旧值回退到可用 page？
