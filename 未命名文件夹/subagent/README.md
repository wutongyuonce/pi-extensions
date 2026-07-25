# Subagent Extension

Lightweight bundled subagents for Pi.

## Shortcuts

Use `#AgentName` in the editor to quickly delegate to bundled agents:

```text
#Explore 查找同步逻辑
#Explore 查问题 > #General 根据上一步结果修复
#Explore 查本地逻辑 | #Scout 查上游实现
```

- `>` runs agents sequentially with `{previous}` passed to the next step.
- `|` runs agents in parallel.
- Agent names are matched case-insensitively and completed dynamically from `.pi/extensions/subagent/agents/*.md`.

The extension also keeps the `subagent` tool available for model-driven delegation. The tool contributes Pi-native prompt guidance (`promptSnippet` / `promptGuidelines`) and dynamically injects a current "Available subagents" section before each agent run.

This lets the main model discover suitable subagents by reading each bundled agent's `name`, `description`, `planMode`, and tools instead of relying on hardcoded agent names. Adding another markdown file under `agents/` is enough to make it visible to the main model.

The guidance encourages, but does not force, delegation. It explicitly avoids delegation for small localized tasks and respects user intent when the user asks not to delegate.

```json
{
  "agent": "Explore",
  "task": "Find code related to resource loading",
  "agentScope": "project",
  "confirmProjectAgents": false
}
```

## Bundled Agents

Bundled agents live in:

```text
.pi/extensions/subagent/agents/*.md
```

To add a new agent, add another markdown file with frontmatter:

```markdown
---
name: MyAgent
description: What this agent is for
tools: read, grep, find, ls
# Plan mode policy: auto = model may call proactively in plan mode;
# explicit = only when user explicitly names this agent; deny = never in plan mode.
# If omitted, read-only tool lists infer auto; unrestricted/writable agents infer explicit.
planMode: auto
# Optional. If omitted, the current Pi default model is used.
# model: provider/model
---

System prompt for the agent.
```

If `model` is omitted, the subagent uses the current Pi default model.

`planMode` controls how the plan-mode extension treats this agent:

- `auto`: the main model may proactively delegate to this agent while staying in plan mode.
- `explicit`: allowed in plan mode only when the user explicitly names the agent.
- `deny`: never allowed in plan mode.

If `planMode` is omitted, agents with only read-only tools infer `auto`; agents without a tool list or with writable tools infer `explicit`.

## Default Agents

### General

模式：subagent

A general-purpose agent for complex questions and multi-step tasks. It has full tool access and may modify files when needed. Use it for implementation, debugging, or larger delegated work units.

### Explore

模式：subagent

A fast read-only codebase exploration agent. It cannot modify files. Use it to find files by pattern, search code, inspect relevant sections, or answer questions about the repository.

### Scout

模式：subagent

A read-only external research agent for dependencies, upstream source code, and external documentation. It may clone external repositories into a managed cache, but must not modify the current workspace.

Recommended cache location:

```text
~/.cache/agentframework/subagents/
```

## Running Widget

While subagents are running, the extension shows a widget above the editor with:

- agent name
- pid
- elapsed time
- model if configured
- task preview

Example:

```text
Subagents running:
  ⏳ Explore pid=1234 8s — 查找资源加载相关代码
```

## Worktree Isolation

Current version does **not** use Git worktree isolation.

`General` runs directly in the current workspace and can modify files. Be careful when running multiple writable General agents in parallel, because they can edit overlapping files.

`Explore` and `Scout` are read-only by prompt and tool policy.

## Safety Notes

- Extension-local agents are repository-controlled prompts.
- `#AgentName` shortcuts run bundled project agents with `confirmProjectAgents: false` because these prompts are part of this trusted config package.
- The raw `subagent` tool still accepts `agentScope` for advanced use.
