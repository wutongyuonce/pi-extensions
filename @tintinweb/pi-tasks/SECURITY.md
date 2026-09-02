# Security Policy

This document explains the security model behind `@tintinweb/pi-tasks` and where
the boundaries are.

`pi-tasks` is a [pi](https://pi.dev) extension. It tracks tasks, coordinates them
across pi sessions through file-backed task lists, tracks background processes,
and can hand tasks to sub-agents (via `@tintinweb/pi-subagents`). All of that
runs locally within the same security boundary as the user running pi, and
inherits pi's trust model. It is the responsibility of the user to monitor those
operations or to contain them within a container, virtual machine, or other
sandbox solution.

Tasks, their tracked processes, and any sub-agents they execute run with the
local user account's privileges and can use the tools they are granted (reading
and writing files, running commands, network access, etc.). They treat the local
user account and files writable by that account as inside the same trust boundary
as the pi process itself. If an attacker can modify files under the user's home
directory, workspace, shell startup files, environment, pi configuration, or this
extension's state and configuration (`.pi/tasks/`, `.pi/tasks-config.json`,
`<agent-dir>/tasks-config.json`), they can generally influence pi, its tasks, or
other local developer tools. Reports that depend on such prior local write access
are not security vulnerabilities unless they demonstrate how `pi-tasks` grants
that write access or crosses an operating-system privilege boundary.

Shared task lists are a deliberate feature: several pi sessions can point at the
same task file to coordinate. Everything written into that file — task content,
outputs, agent types — is trusted input from the sessions sharing it, and is
rendered and fed back to the model as such. File locking exists for concurrency
correctness, not as a security control.

`pi-tasks` relies on the user only loading trustworthy task files, agent
definitions (`.pi/agents/*.md`), skills, and tools, and only using pi within
trusted repositories. Files like `AGENTS.md`, task descriptions, task output,
custom agent frontmatter/system prompts, or instructions embedded in repository
content and comments can be used to prompt-inject the coding agent trivially, and
this cannot be protected against.

## Reporting a Vulnerability

If you believe you found a security vulnerability in `pi-tasks`, please report it
privately by opening a draft advisory through
[GitHub Security Advisories](https://github.com/tintinweb/pi-tasks/security/advisories/new)
for this repository.

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- Affected version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports. Reports will be
reviewed and disclosure coordinated as appropriate.

## Scope

Security issues in the published npm package and the code in this repository are
in scope — for example, a flaw in `pi-tasks` that crosses an operating-system
privilege boundary, or that causes the extension to escape the task directory it
is configured to use, or to bypass a restriction it claims to enforce.

## Out Of Scope

- Local code execution or sandboxing behavior (tracked processes and executed
  sub-agents intentionally do not have a sandbox and run with the user's
  privileges)
- Behavior of pi itself, or of other pi extensions, skills, or tools installed by
  the user (report those to their respective projects)
- Risks from working in untrusted repositories
- Risks from installing or loading untrusted task files, agent definitions,
  skills, extensions, packages, or tools
- Risks from sharing a task list with sessions or users you do not trust
- Issues caused by non-trustworthy MITM proxies
- Public internet exposure of a pi installation
- Prompt injection attacks (including via `AGENTS.md`, task descriptions, task
  output, agent frontmatter, custom system prompts, repository content, or
  context inheritance)
- Exposed secrets that are third-party/user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `.pi/tasks/`,
  `.pi/tasks-config.json`, `<agent-dir>/tasks-config.json`, `.pi/agents/`,
  extension configuration, workspace files, `AGENTS.md`, skills, dotfiles, and
  files synchronized through NFS, roaming profiles, or dotfile managers, unless
  the report shows how `pi-tasks` itself grants that access.
- Issues caused by intentionally weakened user configuration
- Resource/DOS claims that require trusted local input/config
- Reports about malicious model output
- User-approved or user-initiated local actions presented as vulnerabilities

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact. Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted task file/agent definition are not
security vulnerabilities under this model.

For example, a report showing that malicious contents written to a shared task
file or to extension configuration cause the agent to execute commands, load
attacker-controlled tools, or send credentials to an attacker-controlled endpoint
is out of scope.

When possible, include the exact affected path, package version or commit SHA,
configuration, and a proof of concept against the latest release or latest
`master`. For dependency reports, include evidence that the shipped dependency is
affected and that the issue is reachable through `pi-tasks`.
