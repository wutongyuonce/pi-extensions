# Add explicit temporary sandbox disable control

Status: needs-triage

## Problem

Users need an explicit escape hatch to temporarily disable the active sandbox when it blocks legitimate work or adds too much friction.

## Direction

Add manual commands to disable and re-enable sandbox enforcement. Keep the disabled state highly visible in the status line and require an explicit user action.

## Open questions

- Does “off” disable only OS-level sandbox wrapping, or all Guard policy checks too?
- Should the disabled state last only for the current Pi process/session, or persist in `.pi/pi-guard.json`?
- Should disabling require confirmation?
- What command vocabulary is clearest: `/guard off|on` or `/guard sandbox off|on`?

## Design preference

Default to a temporary, session-scoped bypass with conspicuous status, rather than silently persisting an unprotected state.

## Comments

- Requested after observing legitimate commands trigger conservative protection.
- DCG provides an explicit bypass/escape hatch; the same need applies here, but OS sandbox state and static command policy should remain conceptually separate.
- Product direction now calls for three distinct controls: the whole Guard system, the OS sandbox, and DCG. Controls should be available through slash commands and configuration; persistence semantics remain to be decided.
- Project configuration defines startup defaults. Slash commands change only the current Pi run; restart restores project defaults. Runtime changes must be visible so reduced protection is not forgotten.
- Initial compact footer examples use extension-distinguishing brackets: `[Guard: workspace-write · DCG]`, `[Guard: sandbox-off · DCG]`, and `[Guard: OFF]`. UI polish will follow real usage.
- Pi Guard is a TUI-only product; outside interactive TUI mode the Guard system is entirely inactive.
