# Pi Extensions

这是我的个人 [Pi](https://pi.dev/) 扩展仓库，主要收集三类内容：

1. 社区优秀 Pi 扩展的源码归档与镜像
2. 我自己开发或持续维护的 Pi 插件 / 工具项目
3. 面向源码阅读的解析文档与实验性项目

它不是一个统一构建的 monorepo。大多数子目录都是可以独立安装、独立维护、独立阅读的项目；根目录 `README` 更像一个总导航页。

## 快速导航

| 路径 | 说明 |
|---|---|
| [`docs/`](./docs) | 源码解析、阅读索引和专题文档 |
| [`memory/`](./memory) | 记忆、长期上下文与会话延续相关扩展 |
| [`@code-yeongyu/`](./@code-yeongyu) | `pi-goal`、`pi-ast-grep` 等项目 |
| [`@narumiruna/`](./@narumiruna) | `pi-subagents`、`pi-plan-mode`、`pi-lsp`、`pi-firecrawl` 等一组高质量扩展 |
| [`@nicobailon/`](./@nicobailon) | `pi-mcp-adapter`、`pi-intercom`、`pi-web-access` 等 |
| [`@rpiv/`](./@rpiv) | `rpiv-web-tools`、`rpiv-btw`、`rpiv-voice` 等工具扩展 |
| [`@tintinweb/`](./@tintinweb) | `pi-subagents`、`pi-tasks`、`pi-schedule-prompt` |
| [`@AgwaB/`](./@AgwaB) | `pi-subagent`、`pi-workflow` |
| [`pi-*`](./) | 独立维护的自研项目、实验项目和增强工具 |
| [`sandbox/`](./sandbox) | guardrails、sandbox 等安全与隔离相关项目 |
| [`未命名文件夹/`](./未命名文件夹) | 待整理项目与临时归档 |

## 项目索引

### 记忆与上下文

- [`memory/pi-memory`](./memory/pi-memory)：基于 Markdown 的跨会话持久记忆
- [`memory/pi-observational-memory`](./memory/pi-observational-memory)：在压缩、交接和跨天工作中保持会话连续性
- [`memory/pi-hermes-memory`](./memory/pi-hermes-memory)：更偏检索和知识召回的记忆方案

### 多 Agent、协作与工作流

- [`pi-subagents`](./pi-subagents)：主仓版本的多 agent / 子任务框架
- [`@narumiruna/pi-subagents`](./@narumiruna/pi-subagents)：用固定工具把任务委托给隔离子 agent
- [`@tintinweb/pi-subagents`](./@tintinweb/pi-subagents)：Claude Code 风格的自主子 agent
- [`@nicobailon/pi-subagents`](./@nicobailon/pi-subagents)：另一种多 agent 实现
- [`@AgwaB/pi-subagent`](./@AgwaB/pi-subagent)：轻量级子 agent 项目
- [`@AgwaB/pi-workflow`](./@AgwaB/pi-workflow)：工作流编排与技能支撑
- [`pi-dynamic-workflows`](./pi-dynamic-workflows)：更动态的工作流实验
- [`pi-tool-offloading`](./pi-tool-offloading)：工具调用和任务卸载方向的实验项目
- [`@nicobailon/pi-intercom`](./@nicobailon/pi-intercom)：终端间 / agent 间通信能力
- [`@narumiruna/pi-chat`](./@narumiruna/pi-chat)：与其他 peer 交互的聊天式扩展

### 目标、计划与任务管理

- [`@code-yeongyu/pi-goal`](./@code-yeongyu/pi-goal)：持久化 `/goal` 支持
- [`@narumiruna/pi-goal`](./@narumiruna/pi-goal)：目标执行循环与状态持久化
- [`@narumiruna/pi-plan-mode`](./@narumiruna/pi-plan-mode)：Codex 风格的只读规划模式
- [`@narumiruna/pi-todo`](./@narumiruna/pi-todo)：多步骤任务可视化
- [`@rpiv/rpiv-todo`](./@rpiv/rpiv-todo)：另一套 todo 工具实现
- [`@tintinweb/pi-tasks`](./@tintinweb/pi-tasks)：结构化任务跟踪与协调
- [`pi-kanban0`](./pi-kanban0)：项目内 Kanban，看板数据用 Markdown 存储
- [`pi-workspace-history`](./pi-workspace-history)：围绕历史分支切换的工作区状态恢复

### 代码、诊断与自动化

- [`pi-lens`](./pi-lens)：诊断、导航、结构化规则、项目映射和代理护栏
- [`@narumiruna/pi-lsp`](./@narumiruna/pi-lsp)：通过 LSP 暴露诊断与修复能力
- [`@code-yeongyu/pi-ast-grep`](./@code-yeongyu/pi-ast-grep)：结构化代码搜索与改写
- [`@narumiruna/pi-chrome-devtools`](./@narumiruna/pi-chrome-devtools)：通过 CDP 控制 Chrome
- [`@narumiruna/pi-firecrawl`](./@narumiruna/pi-firecrawl)：抓取、搜索和网页研究工具
- [`@narumiruna/pi-github-pr`](./@narumiruna/pi-github-pr)：查看当前 PR 状态
- [`pi-review-loop`](./pi-review-loop)：增量 diff 审查器
- [`pi-autoresearch`](./pi-autoresearch)：自动实验循环与优化闭环
- [`pi-transcribe`](./pi-transcribe)：语音 / 转录相关能力
- [`pi-computer-use`](./pi-computer-use)：桌面自动化与计算机操作

### 工具增强与交互体验

- [`@rpiv/rpiv-web-tools`](./@rpiv/rpiv-web-tools)：为 Pi 增加 `web_search`、`web_fetch`
- [`@nicobailon/pi-mcp-adapter`](./@nicobailon/pi-mcp-adapter)：MCP 协议适配器
- [`pi-tidy-tools`](./pi-tidy-tools)：更紧凑、更易读的工具输出体验
- [`pi-fff`](./pi-fff)：高性能 `find` / `grep` 替代方案
- [`pi-compact-thinking`](./pi-compact-thinking)：紧凑型 thinking 渲染
- [`@nostalfinals pi-compact-thinking`](./@nostalfinals%20pi-compact-thinking)：同类项目的另一份归档
- [`@narumiruna/pi-statusline`](./@narumiruna/pi-statusline)：Powerline 风格状态栏
- [`@narumiruna/pi-btw`](./@narumiruna/pi-btw)：不中断主线的侧向提问命令
- [`@rpiv/rpiv-btw`](./@rpiv/rpiv-btw)：`/btw` 的另一种实现
- [`@rpiv/rpiv-ask-user-question`](./@rpiv/rpiv-ask-user-question)：结构化向用户追问
- [`@rpiv/rpiv-voice`](./@rpiv/rpiv-voice)：语音交互相关扩展
- [`@narumiruna/pi-tool`](./@narumiruna/pi-tool)：浏览 Pi 工具与活动工具状态
- [`@narumiruna/pi-stamp`](./@narumiruna/pi-stamp)：为会话补充时间戳与耗时信息
- [`@narumiruna/pi-langfuse`](./@narumiruna/pi-langfuse)：把 Pi 运行链路接入 Langfuse
- [`pi-web`](./pi-web)：Pi 的 Web 端 / 配套前端探索
- [`@nicobailon/pi-web-access`](./@nicobailon/pi-web-access)：Web 访问能力扩展

### 安全、沙箱与隔离

- [`sandbox/pi-guardrails`](./sandbox/pi-guardrails)：防止误读密钥、误写敏感路径、误执行危险命令
- [`sandbox/pi-guard-sandbox`](./sandbox/pi-guard-sandbox)：更强边界的工作区沙箱
- [`sandbox/pi-sandbox`](./sandbox/pi-sandbox)：沙箱方向的另一套实现 / 实验
- [`@narumiruna/pi-worktree`](./@narumiruna/pi-worktree)：更安全地管理 Git worktree