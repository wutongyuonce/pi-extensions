# Pi Extensions

这是我的 Pi 扩展仓库，主要分成三部分：

1. 我自己写的 extension
2. 社区 extension 的本地镜像 / 归档
3. `docs/` 里的 extension 解析文档

## 我自己写的 Extensions

| 项目 | 本地路径 | 简介 | GitHub |
|---|---|---|---|
| `pi-zen-mode` | [`./pi-zen-mode`](./pi-zen-mode) | Pi 的专注模式。可隐藏 thinking 和 tools，只保留正文流式输出。 | <https://github.com/wutongyuonce/pi-zen-mode> |
| `pi-tool-offloading` | [`./pi-tool-offloading`](./pi-tool-offloading) | 上下文卸载扩展。把过大的工具结果写到 sidecar 文件里，减少后续轮次的上下文占用。 | <https://github.com/wutongyuonce/pi-tool-offloading> |
| `pi-repomap` | [`./pi-repomap`](./pi-repomap) | 代码库感知工具，提供项目概览、符号映射和源码 / 测试文件配对能力。 | <https://github.com/wutongyuonce/pi-repomap> |

## 社区 Extensions

下面这些基本都是社区作者的项目。

### `memory/`

- [`memory/pi-memory`](./memory/pi-memory) - <https://github.com/jayzeng/pi-memory>
- [`memory/pi-observational-memory`](./memory/pi-observational-memory) - <https://github.com/elpapi42/pi-observational-memory>
- [`memory/pi-hermes-memory`](./memory/pi-hermes-memory) - <https://github.com/chandra447/pi-hermes-memory>

### `@code-yeongyu/`

- [`@code-yeongyu/pi-goal`](./@code-yeongyu/pi-goal) - <https://github.com/code-yeongyu/pi-goal>
- [`@code-yeongyu/pi-ast-grep`](./@code-yeongyu/pi-ast-grep) - <https://github.com/code-yeongyu/pi-ast-grep>

### `@narumiruna/`

- [`@narumiruna/pi-tool`](./@narumiruna/pi-tool) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-tool>
- [`@narumiruna/pi-statusline`](./@narumiruna/pi-statusline) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-statusline>
- [`@narumiruna/pi-btw`](./@narumiruna/pi-btw) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-btw>
- [`@narumiruna/pi-chat`](./@narumiruna/pi-chat) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-chat>
- [`@narumiruna/pi-chrome-devtools`](./@narumiruna/pi-chrome-devtools) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-chrome-devtools>
- [`@narumiruna/pi-firecrawl`](./@narumiruna/pi-firecrawl) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-firecrawl>
- [`@narumiruna/pi-github-pr`](./@narumiruna/pi-github-pr) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-github-pr>
- [`@narumiruna/pi-goal`](./@narumiruna/pi-goal) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal>
- [`@narumiruna/pi-langfuse`](./@narumiruna/pi-langfuse) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-langfuse>
- [`@narumiruna/pi-lsp`](./@narumiruna/pi-lsp) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-lsp>
- [`@narumiruna/pi-plan-mode`](./@narumiruna/pi-plan-mode) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode>
- [`@narumiruna/pi-stamp`](./@narumiruna/pi-stamp) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-stamp>
- [`@narumiruna/pi-subagents`](./@narumiruna/pi-subagents) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents>
- [`@narumiruna/pi-todo`](./@narumiruna/pi-todo) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-todo>
- [`@narumiruna/pi-worktree`](./@narumiruna/pi-worktree) - <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-worktree>

### `@nicobailon/`

- [`@nicobailon/pi-intercom`](./@nicobailon/pi-intercom) - <https://github.com/nicobailon/pi-intercom>
- [`@nicobailon/pi-mcp-adapter`](./@nicobailon/pi-mcp-adapter) - <https://github.com/nicobailon/pi-mcp-adapter>
- [`@nicobailon/pi-rewind-hook`](./@nicobailon/pi-rewind-hook) - <https://github.com/nicobailon/pi-rewind-hook>
- [`@nicobailon/pi-subagents`](./@nicobailon/pi-subagents) - <https://github.com/nicobailon/pi-subagents>
- [`@nicobailon/pi-web-access`](./@nicobailon/pi-web-access) - <https://github.com/nicobailon/pi-web-access>

### `@rpiv/`

- [`@rpiv/rpiv-ask-user-question`](./@rpiv/rpiv-ask-user-question) - <https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question>
- [`@rpiv/rpiv-btw`](./@rpiv/rpiv-btw) - <https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-btw>
- [`@rpiv/rpiv-todo`](./@rpiv/rpiv-todo) - <https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo>
- [`@rpiv/rpiv-voice`](./@rpiv/rpiv-voice) - <https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-voice>
- [`@rpiv/rpiv-web-tools`](./@rpiv/rpiv-web-tools) - <https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools>

### `@tintinweb/`

- [`@tintinweb/pi-schedule-prompt`](./@tintinweb/pi-schedule-prompt) - <https://github.com/tintinweb/pi-schedule-prompt>
- [`@tintinweb/pi-subagents`](./@tintinweb/pi-subagents) - <https://github.com/tintinweb/pi-subagents>
- [`@tintinweb/pi-tasks`](./@tintinweb/pi-tasks) - <https://github.com/tintinweb/pi-tasks>

### `@AgwaB/`

- [`@AgwaB/pi-subagent`](./@AgwaB/pi-subagent) - <https://github.com/AgwaB/pi-subagent>
- [`@AgwaB/pi-workflow`](./@AgwaB/pi-workflow) - <https://github.com/AgwaB/pi-workflow>

### `sandbox/`

- [`sandbox/pi-guardrails`](./sandbox/pi-guardrails) - <https://github.com/aliou/pi-guardrails>
- [`sandbox/pi-guard-sandbox`](./sandbox/pi-guard-sandbox) - <https://github.com/RunMintOn/pi-guard-sandbox>
- [`sandbox/pi-sandbox`](./sandbox/pi-sandbox) - <https://github.com/carderne/pi-sandbox>

### 根目录中的社区项目

- [`pi-autoresearch`](./pi-autoresearch) - <https://github.com/davebcn87/pi-autoresearch>
- [`pi-compact-thinking`](./pi-compact-thinking) - <https://github.com/nostalfinals/pi-compact-thinking>
- [`pi-computer-use`](./pi-computer-use) - <https://github.com/injaneity/pi-computer-use>
- [`pi-dynamic-workflows`](./pi-dynamic-workflows) - <https://github.com/Michaelliv/pi-dynamic-workflows>
- [`pi-fff`](./pi-fff) - <https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff>
- [`pi-kanban0`](./pi-kanban0) - <https://github.com/AHGGG/pi-kanban0>
- [`pi-lens`](./pi-lens) - <https://github.com/apmantza/pi-lens>
- [`pi-review-loop`](./pi-review-loop) - <https://github.com/earendil-works/pi-review-loop>
- [`pi-subagents`](./pi-subagents) - <https://github.com/edxeth/pi-subagents>
- [`pi-tidy-tools`](./pi-tidy-tools) - <https://github.com/mikeyobrien/pi-tidy-tools>
- [`pi-transcribe`](./pi-transcribe) - <https://github.com/earendil-works/pi-transcribe>
- [`pi-web`](./pi-web) - <https://github.com/agegr/pi-web>
- [`pi-workspace-history`](./pi-workspace-history) - <https://github.com/wcldyx/pi-workspace-history>
- [`pi-feishu-link`](./pi-feishu-link)
- [`pi-compact-thinking`](./pi-compact-thinking)

## Docs：各个 Extension 的解析文档

`docs/` 目录主要放的是各个 extension 的源码解析、阅读笔记和专题说明，不是独立 extension。
