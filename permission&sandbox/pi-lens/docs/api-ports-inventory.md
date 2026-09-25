# API ports inventory — S1 of #1358

This is a read-only inventory of host state crossing into the engine. The scope is `clients/` and `tools/`; `index.ts` is listed separately as the current pi adapter. A `DispatchContext` is engine-owned, but its `cwd`, `pi.getFlag`, `hasTool`, and `log` members are projections of the host tool context and are therefore included. Engine fields such as `filePath`, facts, project configuration, and runtime state are not host ports.

The sweep used the requested `ctx.`, `pi.`, `ExtensionContext`, and `ExtensionAPI` searches, then followed the named seams and their consumers. There are **84 inventory rows** below. Line numbers refer to the S1 branch at commit time.

## Inventory

| file:line | capability | current mechanism | proposed port name |
|---|---|---|---|
| `tools/ast-grep-outline.ts:144` | workspace cwd | direct `ctx.cwd` read | `workspace.cwd` |
| `tools/ast-grep-replace.ts:181` | workspace cwd | direct `ctx.cwd` read | `workspace.cwd` |
| `tools/ast-grep-search.ts:437,652,661,687` | abort + workspace cwd | direct `ctx.signal`/`ctx.cwd` reads | `lifecycle.abortSignal`, `workspace.cwd` |
| `tools/lens-diagnostic-mark.ts:253` | workspace cwd | direct `ctx.cwd` read | `workspace.cwd` |
| `tools/lens-diagnostics.ts:376,398` | workspace cwd + abort | direct `ctx.cwd`/`ctx.signal` reads | `workspace.cwd`, `lifecycle.abortSignal` |
| `tools/lsp-diagnostics.ts:521,534` | abort + workspace cwd | direct `ctx.signal`/`ctx.cwd` reads | `lifecycle.abortSignal`, `workspace.cwd` |
| `tools/lsp-navigation.ts:992,1084,1128,1490,1496,1516,1521` | flags, workspace cwd, edit cwd | direct `ctx.cwd`; flag closure receives cwd | `flags.get`, `workspace.cwd` (path RESOLUTION is engine logic over `workspace.cwd` — review reclassification, #1360) |
| `tools/module-report.ts:130,131,282,283,438,439` | workspace cwd | direct `ctx.cwd` read | `workspace.cwd` |
| `tools/project-report.ts:76` | workspace cwd | direct `ctx.cwd` read | `workspace.cwd` |
| `tools/symbol-search.ts:73` | workspace cwd | direct `ctx.cwd` read | `workspace.cwd` |
| `tools/activate-tools.ts:87,89` | active-tool registry | direct `pi.getActiveTools`/`pi.setActiveTools` | `tools.active` |
| `clients/dispatch/dispatcher.ts:188,406` | feature flags | direct `pi.getFlag`/`ctx.pi.getFlag` | `flags.get` |
| `clients/dispatch/dispatcher.ts:607,979,1024` | diagnostic logging | direct `ctx.log` | `log.debug` |
| `clients/dispatch/dispatcher.ts:750,780,818,859,867,982,985` | cwd/project root | direct `ctx.cwd`/`ctx.projectRoot` | `workspace.cwd`, `workspace.projectRoot` |
| `clients/dispatch/integration.ts:337,359,394` | feature flags | direct `ctx.pi.getFlag`/`pi.getFlag` | `flags.get` |
| `clients/dispatch/auxiliary-lsp.ts:367` | cwd policy input | direct `ctx.cwd` | `workspace.cwd` |
| `clients/runtime-tool-call.ts:344,357,365,639` | workspace cwd | direct tool-context projection | `workspace.cwd` |
| `clients/runtime-tool-call.ts:452,453` | LSP status UI | direct `ctx.ui.setStatus`/`ctx.ui.theme` | `status.set` |
| `clients/dispatch/runners/actionlint.ts:92` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/ast-grep-napi.ts:556,618,623` | tool availability, cwd, logging | direct `ctx.hasTool`, `ctx.cwd`, `ctx.log` | `tools.has`, `workspace.cwd`, `log.debug` |
| `clients/dispatch/runners/biome-check.ts:83` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/cpp-check.ts:210` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/credo.ts:81` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/dart-analyze.ts:167` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/detekt.ts:148` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/dotnet-build.ts:147` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/elixir-check.ts:166` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/eslint.ts:110` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/fish-indent.ts:22` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/gleam-check.ts:57` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/go-vet.ts:44` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/golangci-lint.ts:129` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/hadolint.ts:61` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/helm-lint.ts:180,188` | project/cwd | direct `ctx.projectRoot`/`ctx.cwd` | `workspace.projectRoot`, `workspace.cwd` |
| `clients/dispatch/runners/htmlhint.ts:69` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/javac.ts:55` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/ktlint.ts:93` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/lsp.ts:119,121,163` | cwd, flags | direct `ctx.cwd`, `ctx.pi.getFlag` | `workspace.cwd`, `flags.get` |
| `clients/dispatch/runners/markdownlint.ts:107` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/mypy.ts:69` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/oxlint.ts:64,82` | runner cwd, tool availability | direct `ctx.cwd`, `ctx.hasTool` | `workspace.cwd`, `tools.has` |
| `clients/dispatch/runners/php-lint.ts:47` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/phpstan.ts:90` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/prisma-validate.ts:56` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/psscriptanalyzer.ts:148` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/pyright.ts:39,44` | flags, runner cwd | direct `ctx.pi.getFlag`, `ctx.cwd` | `flags.get`, `workspace.cwd` |
| `clients/dispatch/runners/rubocop.ts:97` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/ruff.ts:80` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/rust-clippy.ts:66,67,70` | cwd for probe/install | direct `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/shellcheck.ts:144,153,154,182` | cwd, tool availability | direct `ctx.cwd`, `ctx.hasTool` | `workspace.cwd`, `tools.has` |
| `clients/dispatch/runners/shfmt.ts:46` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/spellcheck.ts:105,115` | cwd for probe/command | direct `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/spotbugs.ts:218,222` | cwd, logging | direct `ctx.cwd`, `ctx.log` | `workspace.cwd`, `log.debug` |
| `clients/dispatch/runners/sqlfluff.ts:133,140` | cwd, logging | direct `ctx.cwd`, `ctx.log` | `workspace.cwd`, `log.debug` |
| `clients/dispatch/runners/stylelint.ts:112,120` | cwd, logging | direct `ctx.cwd`, `ctx.log` | `workspace.cwd`, `log.debug` |
| `clients/dispatch/runners/swiftlint.ts:161` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/taplo.ts:60,70` | cwd, tool availability | direct `ctx.cwd`, `ctx.hasTool` | `workspace.cwd`, `tools.has` |
| `clients/dispatch/runners/terragrunt.ts:159` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/tflint.ts:83` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/tree-sitter.ts:429,435,458,522,713` | cwd/config/ignore root | direct dispatch-context `ctx.cwd`/`ctx.projectRoot` | `workspace.cwd`, `workspace.projectRoot` |
| `clients/dispatch/runners/trivy-config.ts:149` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/vale.ts:135` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/dispatch/runners/yamllint.ts:52,59` | cwd, logging | direct `ctx.cwd`, `ctx.log` | `workspace.cwd`, `log.debug` |
| `clients/dispatch/runners/zig-check.ts:61` | runner cwd | direct dispatch-context `ctx.cwd` | `workspace.cwd` |
| `clients/project-trust.ts:51,86` | project trust | host accessor read, then latched singleton | `trust.isProjectTrusted` |
| `clients/extension-mode.ts:50` | run mode | host accessor read at call site | `mode.current` |
| `clients/user-notify.ts:30,50` | human notification | live getter seam over `ctx.ui.notify` | `notify.user` |
| `clients/lens-events.ts:66,111` | event emission | live bus getter, resolved at deferred delivery | `emit.lens` |
| `clients/bus-publish.ts:83,196` | files-touched event | live emitter getter | `emit.bus` |
| `clients/diagnostics-publish.ts:130` | diagnostics event | live emitter getter | `emit.bus` |
| `clients/disposition-publish.ts:62` | disposition event | live emitter getter | `emit.bus` |
| `clients/format-events-publish.ts:130` | format/autofix events | live emitter getter | `emit.bus` |
| `clients/safe-spawn.ts:322,987` | turn cancellation for children | ambient abort signal set by adapter, read deep by spawn helper | `spawn.abortSignal` |
| `clients/widget-state.ts:142,205` | TUI invalidation | callback setter invoked by adapter; engine calls callback | `render.invalidate` |
| `clients/runtime-session.ts:104,970,1755` | session-start user output | notifier passed as callback parameter | `notify.user` |
| `clients/runtime-agent-end.ts:44,97,512` | agent-end user output | notifier passed as callback parameter | `notify.user` |
| `clients/lsp/config.ts:119` | invalid-config user output | `notifyUserDegradation` getter seam plus log sink | `notify.user`, `log.extension` |
| `clients/dispatch/runners/tree-sitter.ts:429,458` | tree-sitter config degradation | parameterized cwd plus notifier from config loader | `workspace.cwd`, `notify.user` |
| `clients/runtime-tool-call.ts:559,597,791,822,923,1038,1070,1112` | stable session identity in telemetry | parameter threaded from adapter/runtime identity | `session.id` |
| `clients/session-lifecycle.ts:298,333` | primary/secondary session identity | adapter extracts host session id and passes it in | `session.id` |
| `clients/session-state-store.ts:79,144` | persisted session state namespace | session id parameter threaded from adapter | `session.id` |
| `clients/extension-log.ts:35` | extension log sink | process/global-dir-derived static NDJSON sink | `log.extension` |
| `clients/actionable-warnings-logger.ts:16`, `ast-grep-tool-logger.ts:28`, `bus-events-logger.ts:43`, `cascade-logger.ts:10`, `dead-code-logger.ts:22`, `diagnostic-logger.ts:90`, `disposition-logger.ts:32`, `latency-logger.ts:10`, `read-guard-logger.ts:17`, `review-graph-logger.ts:16`, `sessionstart-logger.ts:12`, `tree-sitter-logger.ts:11`, `word-index-logger.ts:30` | subsystem log sinks | `createNdjsonLogger` consumers; no ExtensionAPI read, but host-owned process/filesystem policy is implicit | `log.sink` |
| `clients/debug-handles.ts:153`, `clients/debug-heap.ts:77` | optional diagnostic log sinks | `createNdjsonLogger` consumers gated by environment | `log.sink` |

## Draft `HostPorts` shape

This is intentionally an interface sketch for S2, not an implementation. It keeps host capabilities grouped by concern, makes live getters explicit where session replacement matters, and leaves engine data (`cwd`, file paths, and event payloads) as ordinary arguments rather than hiding them in a host object.

```ts
export interface HostPorts {
	readonly notify: {
		user(message: string, level?: "info" | "warning" | "error"): void;
	};
	readonly trust: {
		isProjectTrusted(): "trusted" | "untrusted" | "unknown";
	};
	readonly mode: {
		current(): "tui" | "rpc" | "json" | "print" | "unknown";
		supportsTuiWidget(): boolean;
		suppressesUserNotify(): boolean;
	};
	readonly log: {
		extension(entry: { subsystem: string; message: string; level?: string; metadata?: Record<string, unknown> }): void;
		debug(message: string, metadata?: Record<string, unknown>): void;
		/** Subsystem NDJSON sink factory (the 13 subsystem-logger rows + debug
		 * sinks) — host owns the directory/retention policy. */
		sink(subsystem: string): (entry: object) => void;
	};
	readonly emit: {
		bus(channel: string, payload: unknown): void;
		lens(channel: string, payload: unknown): void;
	};
	readonly status: {
		set(name: string, value: string): void;
	};
	readonly spawn: {
		abortSignal(): AbortSignal | undefined;
		/** Trust-gated install/materialization policy (clients/project-trust.ts assertInstallAllowed; adapter-surface today -- callers in index.ts). */
		isAllowed(context: string): boolean;
	};
	readonly render: {
		invalidate(): void;
	};
	readonly session: {
		id(): string | undefined;
	};
	readonly workspace: {
		cwd(): string | undefined;
		projectRoot(): string | undefined;
	};
	readonly flags: {
		get(name: string, filePath?: string): string | boolean | undefined;
	};
	readonly tools: {
		has(name: string): Promise<boolean>;
		getActive(): string[];
		setActive(names: string[]): void;
	};
}
```

## Four hardest migrations

1. **Dispatch runner context fan-out (`clients/dispatch/runners/*`, especially `tree-sitter.ts`, `lsp.ts`, and `ast-grep-napi.ts`).** Dozens of runners read `cwd`, availability, flags, and logging through `DispatchContext`; replacing these safely requires separating engine context from host projections without changing runner scheduling or fallback semantics. The existing `PiAgentAPI` is only a flag fragment, so this is the largest mechanical and typing migration.

2. **Turn-scoped abort propagation (`index.ts` → `setAmbientAbortSignal` → `clients/safe-spawn.ts`).** The ambient signal is intentionally available deep inside arbitrary child-spawn paths, and its correctness depends on lifecycle ordering and clearing every settle path. A port must preserve cancellation, session replacement, and print-mode handle behavior without reintroducing captured-context races.

3. **Session-bound UI/status and event delivery (`clients/runtime-tool-call.ts`, `clients/widget-state.ts`, and the bus/event publishers).** UI getters, status setters, render invalidation, and event emitters can all outlive the context that supplied them. The existing getter seams solve some cases, but consolidating them requires preserving delivery-time resolution, dropped-event observability, and no-throw behavior across TUI/RPC/MCP hosts.

4. **Read-guard tool-event seam** (`index.ts:1722-1734` → `clients/runtime-tool-call.ts`; `index.ts:1739-1745` → `clients/runtime-tool-result.ts`): the tool-call/tool-result coupling and strict ordering make this at least as hard as the UI/event migration — the port must preserve event order and the paired-call identity across session replacement (#1360 review addition).

## S2 recommendation

Implement `HostPorts` as a host-neutral capability object assembled by each adapter, but migrate one capability family at a time behind the existing seams: first notify/trust/mode, then emit/log/status/render, then workspace/flags/tools/session/spawn. Keep current getters as canonical adapter implementations during the transition, and add a contract test that the MCP and pi adapters provide the same defaults (no-op notify/emit/status/render, unknown trust/mode, and no ambient abort) before changing engine call signatures.
