# Pi LSP Guidelines

## Protocol behavior

- Return one empty configuration object per `workspace/configuration` request item for ty and Ruff.
- Allow a bounded rust-analyzer-specific grace period for a newer push diagnostic after an initially empty pull result.
- On Windows, resolve extensionless commands against the adapter's effective `PATH` and child cwd, then launch `.cmd` or `.bat` shims through `%ComSpec%`.
- Preserve per-session ownership for concurrent work sharing one adapter status key so one completion cannot clear a running sibling.

## Configuration and catalog

- Prefer canonical JSON and explicit argv arrays for configuration.
- Avoid extension-specific environment-variable settings, but retain `servers[].env` for child-process needs.
- Keep the built-in catalog limited to direct-command, non-overlapping routes for real standalone launchers, including required initialization, platform-wrapper behavior, and dialect-specific language IDs.
