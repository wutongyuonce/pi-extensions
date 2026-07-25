# Pi Extensions

这是我的个人 [Pi](https://pi.ai) 扩展集合，汇集了自己开发的和社区中优秀的 Pi Agent 扩展插件。

## 插件列表

### 记忆与上下文

| 插件 | 描述 |
|---|---|
| **@jayzeng / pi-memory** | Pi 生态中最流行的记忆扩展，通过纯 Markdown 文件（含可选的语义搜索）为 Pi 提供跨会话持久记忆。 |
| **@elpapi42 / pi-observational-memory** | 在压缩、交接和跨天工作中保持长 agent 会话的连贯性，让 Pi 会话感觉永无止境。 |

### 多 Agent 与子任务

| 插件 | 描述 |
|---|---|
| **@edxeth / pi-subagents** | 高度精心编排的多 agent 框架：命名 agent、交互式面板、后台 worker、异步并行、子父通信、TUI 微件等。 |
| **@edxeth / edxeth-pi-subagents** | 多 agent 框架早期版，支持命名 agent、交互式面板、后台 worker、异步并行等。 |
| **@narumitw / pi-subagents** | 用 5 个固定工具将工作委托给专门化的隔离子过程 agent。 |
| **@tintinweb / pi-subagents** | Claude Code 风格的自主子 agent，支持前台/后台运行、中途引导、恢复已完成的会话等。 |

### 目标与计划

| 插件 | 描述 |
|---|---|
| **@code-yeongyu / pi-goal** | 为 Pi 提供持久化的 `/goal` 支持，含会话作用域目标存储和 Codex 风格 TUI。 |
| **@code-yeonyu / pi-goal** | 同上（另一个分支/镜像版本）。 |
| **@narumitw / pi-goal** | 提供会话作用域的 `/goal` 命令、`goal_complete` 和 `goal_blocked` 工具，支持可选的队列模式。 |
| **@narumitw / pi-plan-mode** | Codex 风格的 `/plan` 协作模式，用于只读探索和生成结构化实施计划。 |

### 安全与沙箱

| 插件 | 描述 |
|---|---|
| **@aliou / pi-guardrails** | 安全检查层，防止 agent 意外读取密钥、写入受保护文件或执行危险命令。 |
| **@RunMintOn / pi-guard-sandbox** | 高权限 OS 级沙箱，通过真实的边界强制在工作区内给予 agent 完全自由，在工作区外拦截越界行为。 |

### 代码与开发

| 插件 | 描述 |
|---|---|
| **@injaneity / pi-computer-use** | 让 AI agent 能在 macOS 和 Windows 上操作桌面应用，支持查看窗口、点击、输入、滚动等操作。 |
| **@narumitw / pi-lsp** | 通过可配置的语言服务器协议路由，暴露诊断和源码修复工具，语言无关。 |
| **@narumitw / pi-chrome-devtools** | 通过 Chrome DevTools Protocol 提供浏览器标签检查、导航、执行 JS 和截图等自动化能力。 |
| **@earendil-works / pi-review-loop** | 持久化的增量 diff 审查器，保持原生审查窗口，每次只显示自上次审查以来的变更。 |
| **pi-repomap** | 代码库感知 CLI，按跨文件重要性排序的符号、项目概览和源/测试对映射。 |
| **@MattDevy / pi-compass** | 代码库导航工具，生成结构化 codemap 和交互式代码导览。 |

### 工具增强

| 插件 | 描述 |
|---|---|
| **@juicesharp / rpiv-web-tools** | 为 Pi 添加 `web_search` 和 `web_fetch` 工具，支持从 10 种后端中选其一。 |
| **@nicobailon / pi-mcp-adapter** | MCP 协议适配器，惰性加载工具、按需授权，让 Pi 可以使用 MCP 服务器而不会烧掉上下文窗口。 |
| **@mikeyobrien / pi-tidy-tools** | 通过紧凑的、以推理为先的输出替换原生 tool card，让会话记录更易读。 |
| **pi-fff** | 使用 Rust 原生 SIMD 加速替换内置的 `find` 和 `grep` 工具，支持模糊匹配、预索引、Git 感知等。 |

### 学习与自动化

| 插件 | 描述 |
|---|---|
| **@MattDevy / pi-continuous-learning** | 观察编码会话，从中提炼出可复用的"直觉"——带置信度评分、项目作用域的原子化学习行为。 |
| **@tintinweb / pi-schedule-prompt** | 心跳式定时调度扩展，让 agent 可自我安排在特定时间或间隔执行的提示。 |
| **@tintinweb / pi-tasks** | Claude Code 风格的任务跟踪和协调，支持结构化任务、依赖管理和持久化可视化微件。 |
| **@nostalfinals / pi-compact-thinking** | 将 Pi 内置的思考块渲染器替换为紧凑的、带动画效果的思考过程预览。 |

### UI 与交互

| 插件 | 描述 |
|---|---|
| **@narumitw / pi-statusline** | Powerline 样式的底部状态栏，开箱即用且随终端宽度自适应。 |
| **@narumitw / pi-btw** | `/btw` 侧向提问命令，用于不中断主对话的快速澄清和临时询问。 |
| **@narumitw / pi-image-drop** | 私有环回页面，用于粘贴、拖放、选择和排序本地图片，按序附加到下一条消息中。 |
| **@narumitw / pi-firecrawl** | 将 Firecrawl 的抓取、爬取、URL 发现和搜索 API 暴露为 Pi 工具。 |
| **@narumitw / pi-worktree** | 安全的 Git worktree 管理，支持交互式 worktree 操作和 Pi 工作区切换。 |

### 其他

| 插件 | 描述 |
|---|---|
| **ponytail** | 将 Ponytail 的规则注入 AI agent 的会话生命周期中。 |
