# Design principles

These principles define Pi Subagents rather than requirements for every Pi subagent implementation.

## Context isolation is the purpose

A subagent starts as a fresh Pi process.

It does not inherit the main agent's conversation history.

That isolation is not a limitation—it is the point.

Fresh does not mean empty.

The subagent still receives Pi's standard system prompt, the main agent's effective model, applicable project context, its selected tools, and one explicit task.

The task defines the child's specialization, while the selected tools define its authority.

Give each subagent a self-contained task containing only the context needed to complete that task.

If work depends on substantial history from the current conversation, continue in the current thread instead of copying that history into a new subagent.

## Simplicity over feature breadth

Keep the architecture explicit, minimal, and easy to understand.

Feature breadth alone does not justify more machinery.

Prefer a small system whose behavior can be understood end to end over a feature-complete system whose behavior is obscured by layers of abstraction and orchestration.

Every capability must earn its place: its value must outweigh both the complexity it introduces and the maintenance burden it leaves behind.
