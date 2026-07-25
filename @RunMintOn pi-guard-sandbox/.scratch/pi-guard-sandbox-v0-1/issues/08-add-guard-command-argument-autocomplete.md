# Add argument autocomplete for `/guard`

Status: needs-triage

## Problem

After typing `/guard `, users currently have to type the complete subcommand instead of selecting or completing it with Tab.

## Direction

Use Pi's documented `registerCommand()` `getArgumentCompletions` callback to provide completions for Guard subcommands and aliases.

Candidate completions include:

- `init`
- `read-only`
- `workspace-write`
- `network-on`
- `network-off`
- future sandbox enable/disable commands

Short aliases may remain accepted without being the primary displayed suggestions.

## Acceptance considerations

- Tab completion works after `/guard `.
- Suggestions filter by the currently typed prefix.
- Labels/descriptions make the effect of each command clear.
- Completion vocabulary stays synchronized with the command handler and help text.

## Comments

- Pi supports this directly through `getArgumentCompletions`; no custom editor or general autocomplete provider is needed for ordinary slash-command arguments.
