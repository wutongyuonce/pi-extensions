# 🧠 pi-lsp — Run Targeted LSP Diagnostics and Fixes

[![npm](https://img.shields.io/npm/v/@narumitw/pi-lsp)](https://www.npmjs.com/package/@narumitw/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give Pi targeted Language Server Protocol diagnostics and source fixes during an edit.
Configure language servers by command and file extension instead of relying on hard-coded language families.

## ✨ Features

- Configures language servers in JSON and routes files by extension.
- Runs multiple servers for the same file type when complementary diagnostics are useful.
- Exposes `lsp_diagnostics` for exact ranges and `lsp_fix` for supported source actions.
- Supports workspace roots, bounded discovery, per-call server overrides, and preview-or-write edits.
- Starts servers only for tool calls, shuts them down afterward, and shows activity only while they run.

## 📦 Install

```bash
pi install npm:@narumitw/pi-lsp
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-lsp
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-lsp run build
pi -e ./packages/pi-lsp
```

The package declares `dist/index.ts`, so Pi cannot load an unbuilt local checkout.
Pi extensions run with your user permissions.
Review extension source before installing it.

## 🚀 Quick start

Install at least one language server from the built-in catalog on `PATH`, then run `/lsp` to check command availability.
The agent can call `lsp_diagnostics` for targeted diagnostics and `lsp_fix` for supported source actions.

## 🎯 When to use pi-lsp

Use pi-lsp when a language server can answer a targeted question about the files being edited faster than the project's authoritative checks.
It is most useful when:

- a full-project lint or typecheck is slow, but only a few files need intermediate feedback;
- exact diagnostic ranges and severity are easier to act on than CLI output;
- a server provides a useful source action such as `source.fixAll` or `source.organizeImports`;
- a multi-language repository benefits from one configurable diagnostics interface.

First document the repository's authoritative format, lint, typecheck, build, and test commands in `AGENTS.md`.
Use pi-lsp for intermediate feedback, then run those authoritative commands before declaring the task complete.
If the repository checks are already fast and reliable, pi-lsp may add little value.

A practical workflow is:

1. Call `lsp_diagnostics` when targeted feedback is useful.
2. Optionally call `lsp_fix` for a server-supported source action.
3. Run the repository's authoritative validation commands before completion.
4. Use pre-commit hooks and CI as the final enforcement layer.

## ⚙️ Settings

Without a config file, pi-lsp uses the built-in direct-command catalog below.
pi-lsp does not download language servers, so install the commands you need and put them on `PATH`.
A server starts only when a tool call requests a matching file.
With the built-in catalog, diagnostics skips unavailable default commands before workspace discovery.
If no default command can run, diagnostics succeeds and reports the skipped servers.
An explicitly selected or custom-configured missing command still reports an error.

| Language or format | Default server | Startup command | Extensions |
| --- | --- | --- | --- |
| JavaScript, TypeScript, JSON, CSS, GraphQL, HTML, Vue, Astro, Svelte | `biome` | `biome lsp-proxy` | `.js`, `.jsx`, `.ts`, `.tsx`, `.json`, `.jsonc`, `.css`, `.graphql`, `.gql`, `.html`, `.vue`, `.astro`, `.svelte`, and module variants |
| Python typing | `ty` | `ty server` | `.py`, `.pyi` |
| Python linting and fixes | `ruff` | `ruff server` | `.py`, `.pyi` |
| Rust | `rust-analyzer` | `rust-analyzer` | `.rs` |
| Go | `gopls` | `gopls` | `.go` |
| Ruby | `rubocop` | `rubocop --lsp` | `.rb`, `.rake`, `.gemspec`, `.ru` |
| Elixir | `elixir-ls` | `language_server.sh` (`language_server.bat` on Windows) | `.ex`, `.exs` |
| Zig | `zls` | `zls` | `.zig`, `.zon` |
| C# | `csharp` | `roslyn-language-server --stdio --autoLoadProjects` | `.cs`, `.csx` |
| F# | `fsharp` | `fsautocomplete` | `.fs`, `.fsi`, `.fsx`, `.fsscript` |
| Swift and Objective-C++ | `sourcekit-lsp` | `sourcekit-lsp` | `.swift`, `.mm` |
| C and C++ | `clangd` | `clangd --background-index --clang-tidy` | C/C++ source and header extensions |
| Java | `jdtls` | `jdtls` | `.java` |
| Kotlin | `kotlin-lsp` | `kotlin-lsp --stdio` | `.kt`, `.kts` |
| YAML | `yaml-language-server` | `yaml-language-server --stdio` | `.yaml`, `.yml` |
| Lua | `lua-language-server` | `lua-language-server` | `.lua` |
| PHP | `intelephense` | `intelephense --stdio` | `.php` |
| Prisma | `prisma` | `prisma-language-server --stdio` | `.prisma` |
| Dart | `dart` | `dart language-server` | `.dart` |
| OCaml | `ocaml-lsp` | `ocamllsp` | `.ml`, `.mli` |
| Bash | `bash-language-server` | `bash-language-server start` | `.sh`, `.bash` |
| Terraform | `terraform-ls` | `terraform-ls serve` | `.tf`, `.tfvars` |
| LaTeX and BibTeX | `texlab` | `texlab` | `.tex`, `.bib` |
| Gleam | `gleam` | `gleam lsp` | `.gleam` |
| Clojure | `clojure-lsp` | `clojure-lsp listen` | `.clj`, `.cljs`, `.cljc`, `.edn` |
| Nix | `nixd` | `nixd` | `.nix` |
| Typst | `tinymist` | `tinymist` | `.typ`, `.typc` |
| Haskell | `haskell-language-server` | `haskell-language-server-wrapper --lsp` | `.hs`, `.lhs` |

For example, install the Rust and Go servers with their official toolchains:

```bash
rustup component add rust-analyzer rust-src
go install golang.org/x/tools/gopls@latest
```

Ensure the Go install directory (`$GOBIN` or `$(go env GOPATH)/bin`) is also on `PATH`.

pi-lsp resolves configuration in this order:

1. `<workspace>/.pi/pi-lsp.json`, only when Pi trusts the current project
2. `~/.pi/agent/pi-lsp.json`
3. the built-in server catalog

pi-lsp ignores both project files when Pi does not trust the project.
A tool's `root` selects files and the server working directory; it does not authorize that directory's project settings.
Project settings always come from the trusted Pi session workspace.

For compatibility, pi-lsp still reads user-scoped `lsp.json` and trusted project-scoped `.pi/lsp.json` with a warning.
It never modifies legacy files automatically.
Rename them to their canonical `pi-lsp.json` names.
Canonical paths take precedence when both names exist.

pi-lsp-specific environment settings have been removed.
Move their values into canonical JSON:

| Removed setting | JSON replacement |
| --- | --- |
| `PI_LSP_CONFIG` inline JSON | Save the same object as user `pi-lsp.json` or trusted project `.pi/pi-lsp.json` |
| `PI_LSP_CONFIG=/path/to/file.json` | Move or copy that configuration to one of the canonical paths above |
| `PI_<SERVER>_LSP_COMMAND` | Set the server's `command` to an argv array, with one string per executable or argument |

`servers[].env` remains supported because it configures the launched language-server process, not pi-lsp.

Any custom config replaces the entire built-in server map.
The following `pi-lsp.json` example intentionally keeps five selected servers:

```json
{
  "ty": {
    "command": ["ty", "server"],
    "extensions": [".py", ".pyi"]
  },
  "ruff": {
    "command": ["ruff", "server"],
    "extensions": [".py", ".pyi"]
  },
  "biome": {
    "command": ["biome", "lsp-proxy"],
    "extensions": [
      ".astro",
      ".css",
      ".graphql",
      ".gql",
      ".html",
      ".js",
      ".jsx",
      ".json",
      ".jsonc",
      ".ts",
      ".tsx",
      ".vue"
    ]
  },
  "rust-analyzer": {
    "command": ["rust-analyzer"],
    "extensions": [".rs"],
    "pullDiagnosticsGraceMs": 5000
  },
  "gopls": {
    "command": ["gopls"],
    "extensions": [".go"]
  }
}
```

Use `servers` when you need global pi-lsp options such as timeout:

```json
{
  "timeout": 30000,
  "servers": {
    "ty": {
      "command": ["ty", "server"],
      "extensions": [".py", ".pyi"],
      "env": {
        "LSP_LOG": "debug"
      },
      "initialization": {
        "settings": {}
      },
      "skipDirectories": ["generated"]
    }
  }
}
```

Each server entry supports:

- `command`: argv array used to start the LSP server.
- `extensions`: file extensions that should route to this server.
- `env`: environment overrides for the LSP server process.
  The child inherits Pi's environment, then applies these values; an `env.PATH` value is also used to resolve `command[0]`.
- `initialization`: LSP initialization options and workspace configuration values.
- `skipDirectories`: additional directory names to exclude from recursive discovery.
  Explicitly requested paths remain available.
- `diagnosticsSettleMs`: positive number of milliseconds without another push-diagnostics publication before using the latest result.
  Defaults to `800`; the built-in intelephense route uses `4000`.
  The global timeout remains the upper bound.
- `pushDiagnosticsGraceMs`: positive number of milliseconds to wait for the first publication from a push-only server.
  It is unset by default, so a silent push-only server waits for the global timeout.
  The built-in Lua and Haskell routes use `3000`; Dart, Terraform, Gleam, and Tinymist use `2000`.
  This lets clean files finish after bounded silence without returning before a late error publication.
- `pullDiagnosticsGraceMs`: positive number of milliseconds to wait for a newer push publication after a server returns an empty pull-diagnostics result.
  It is unset by default; the built-in rust-analyzer route uses `5000` because initial workspace analysis can finish after an early empty pull response.

Global options:

- `timeout`: request timeout in milliseconds.
  Defaults to `20000`.

pi-lsp infers `languageId` from common extensions and falls back to the extension without the leading dot.

For example, run the configured Ruff server through the project's uv environment without shell-string parsing:

```json
{
  "servers": {
    "ruff": {
      "command": ["uv", "run", "--no-sync", "ruff", "server"],
      "extensions": [".py", ".pyi"]
    }
  }
}
```

## ⚠️ Tool changes

`lsp_format` is no longer provided. pi-lsp now focuses on LSP diagnostics and source code actions:

- `lsp_diagnostics`
- `lsp_fix`

Use project formatters or shell commands for formatting workflows.

## 🛠️ Tools

### `lsp_diagnostics`

Run diagnostics through configured servers.

Parameters:

- `paths?`: files or directories to check.
  Defaults to the workspace root.
- `root?`: workspace root.
  Defaults to cwd.
- `limit?`: maximum files to open per selected server.
- `server?`: configured server name, or an array of names.
  Defaults to all matching servers.

### `lsp_fix`

Apply source fixes or import organization through a configured server that matches its extension.
If multiple servers match, pass `server` explicitly.

Parameters:

- `path`: file to fix.
- `root?`: workspace root.
  Defaults to cwd.
- `kind?`: source action kind.
  Defaults to `source.fixAll`.
- `write?`: write fixed text back to the file.
  Defaults to false.
- `server?`: optional configured server name.

## 💬 Commands

```text
/lsp
```

In TUI and RPC modes, it shows each configured LSP command and whether it is available on `PATH`.
For compatibility, `/lsp` ignores command arguments.

## 🔒 Security and privacy

pi-lsp starts configured language-server commands with your user permissions.
User config is trusted input, and project config is used only when Pi trusts the current project.
Review every configured command, argument, environment value, and initialization option before using it.
A server process inherits Pi's environment and receives any `servers[].env` overrides.

## 🚧 Limitations

- Diagnostics are not injected continuously; the agent must call `lsp_diagnostics`.
- Language servers start and stop for each tool call, so pi-lsp does not keep an editor-like incremental session.
- The tools provide diagnostics and source code actions, not symbol navigation, references, or semantic rename.
- A clean LSP result does not replace the repository's formatter, linter, type checker, build, or tests.
- This project has not demonstrated through benchmarks that LSP improves agent task success, latency, or tool use.

This guidance is informed by [Eric Traut's comment on LSP integration for coding agents](https://github.com/openai/codex/issues/8745#issuecomment-3713058579).
The comment notes that repository-native checks may already provide much of the useful verification.

## 🗂️ Package layout

```txt
packages/pi-lsp/
├── dist/                  # Generated TypeScript runtime loaded by Jiti
├── scripts/
│   └── build-runtime.mjs  # Deterministic runtime builder and boundary validator
├── src/
│   ├── index.ts
│   ├── adapters.ts
│   ├── command.ts
│   ├── files.ts
│   ├── lsp-client.ts
│   ├── pi-lsp.ts
│   ├── routes.ts
│   ├── runner.ts
│   ├── text-edits.ts
│   └── types.ts
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The generated runtime is built from the authoritative `src/index.ts` graph and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi Coding Agent, Language Server Protocol, LSP diagnostics, code actions, source fixes, configurable language servers, TypeScript Pi package.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
