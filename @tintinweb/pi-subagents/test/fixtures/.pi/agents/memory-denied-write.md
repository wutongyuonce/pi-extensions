---
description: "memory + disallowed_tools — a denied write tool must not count as write capability."
memory: project
tools: read, write
disallowed_tools: write
expect_tools_present: "read"
expect_tools_absent: "write, edit, bash, grep"
expect_prompt_contains: "Agent Memory (read-only), Memory scope: project"
expect_prompt_absent: "persistent memory directory"
---
README: "The `disallowed_tools` field is respected when determining write
capability — an agent with `tools: write` + `disallowed_tools: write` correctly
gets read-only memory."

This is the combination neither `memory-readonly.md` (no write tool at all) nor
`memory-readwrite.md` (write tool, nothing denied) exercises: the write tool IS
in the `tools:` set, so a naive capability check sees it and hands the agent the
read-write memory prompt — which also appends `write`/`edit` to the tool names,
widening the set the agent asked for. The denylist still filters the registry, so
the visible symptom is an agent instructed to write memory files with no tool to
do it; the invisible one is the tool-name widening.

Scope `project` is safe here precisely because the read-only branch creates no
memory directory — if this fixture ever flips to the read-write branch, it would
also start writing into the repo, which is the loudest possible signal.
