import { createGuardController, displayMode } from "./guard.mjs";

export const GUARD_COMMANDS = [
  ["status", "Show full Guard runtime status"], ["init", "Create the default project config"],
  ["on", "Enable Guard for this Pi run"], ["off", "Disable Guard for this Pi run"],
  ["sandbox on", "Enable OS sandbox for this Pi run"], ["sandbox off", "Disable OS sandbox for this Pi run"],
  ["dcg on", "Enable optional DCG policy for this Pi run"], ["dcg off", "Use the built-in Bash policy for this Pi run"],
  ["read-only", "Use read-only sandbox mode for this Pi run"], ["workspace-write", "Allow workspace writes for this Pi run"],
  ["network on", "Allow sandbox network access for this Pi run"], ["network off", "Block sandbox network access for this Pi run"],
];

export function getGuardArgumentCompletions(prefix = "") {
  const normalized = String(prefix).toLowerCase();
  const items = GUARD_COMMANDS.map(([value, description]) => ({ value, label: value, description }));
  const matches = items.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

export function renderStatus(status) {
  const lines = [
    `Guard: ${status.guardActive ? "enabled" : "OFF"}`,
    `Sandbox: ${status.sandboxEnabled ? (status.sandboxActive ? "enabled" : "unavailable") : "off"}`,
    `Mode: ${displayMode(status.mode)}`,
    `Network: ${status.network ?? "open"}`,
    `DCG config: ${status.dcgConfigured ? "enabled" : "disabled"}`,
    `DCG runtime: ${status.dcgEnabled ? "enabled" : "off"}`,
    `DCG binary: ${status.dcgAvailability === "available" ? "available" : status.dcgAvailability === "missing" ? "missing" : status.dcgAvailability === "error" ? "error" : "not checked (DCG disabled)"}`,
    `Bash policy: ${status.bashPolicy === "dcg-error" ? "DCG (error, retrying)" : status.bashPolicy === "dcg" ? "DCG" : "built-in"}`,
    `DCG error: ${status.dcgError ? "yes" : "no"}`,
    `DCG actions: deny=${status.config?.dcg.onDeny ?? "n/a"}, indeterminate=${status.config?.dcg.onIndeterminate ?? "n/a"}, error=${status.config?.dcg.onError ?? "n/a"}`,
    `Runtime overrides: ${status.overrides.length ? status.overrides.join(", ") : "none"}`,
    "Slash overrides last only for this Pi run; restart restores project defaults.",
    `Config: ${status.configPath}`,
    `Workspace: ${status.workspaceRoot}`,
    "Scope: interactive TUI Agent tools only (!cmd/!!cmd are not guarded).",
  ];
  if (status.dcgErrorReason) lines.push(`DCG error detail: ${status.dcgErrorReason}`);
  if (status.error) lines.push(`Error: ${status.error}`);
  return lines.join("\n");
}

/** Register only after a TUI session begins, so other Pi modes stay untouched. */
export function registerPiGuard(pi, { createSandbox, createLocalOps, createBashTool, createDcgClient } = {}) {
  let guard;
  let sandbox;
  let registered = false;

  const updateStatus = (ctx) => { if (ctx.mode === "tui" && guard) ctx.ui.setStatus("pi-guard", guard.getStatus().footer); };
  const approval = (ctx) => ({
    hasUI: ctx.mode === "tui",
    requestApproval: ({ title, body }) => ctx.ui.confirm(title, body),
    notify: (message, level) => ctx.ui.notify(message, level),
  });

  async function handleCommand(args, ctx) {
    if (ctx.mode !== "tui" || !guard) return;
    const command = String(args ?? "").trim().toLowerCase();
    try {
      if (!command || command === "status") { ctx.ui.notify(renderStatus(guard.getStatus()), "info"); return; }
      if (command === "i" || command === "init") {
        const result = await guard.initializeConfig();
        ctx.ui.notify(result.created ? `Initialized ${result.path}` : `Guard config already exists at ${result.path}`, result.created ? "success" : "warning");
      } else if (["r", "readonly", "read-only"].includes(command)) {
        await guard.setMode("readonly"); ctx.ui.notify("Guard mode set to read-only for this Pi run.", "success");
      } else if (["w", "workspace-write"].includes(command)) {
        await guard.setMode("workspace-write"); ctx.ui.notify("Guard mode set to workspace-write for this Pi run.", "success");
      } else if (["non", "network on", "network-on"].includes(command)) {
        await guard.setNetwork("open"); ctx.ui.notify("Network enabled for this Pi run.", "success");
      } else if (["noff", "network off", "network-off"].includes(command)) {
        await guard.setNetwork("blocked"); ctx.ui.notify("Network blocked for this Pi run.", "warning");
      } else if (command === "on") {
        await guard.setGuardEnabled(true); ctx.ui.notify("Guard enabled for this Pi run.", "success");
      } else if (command === "off") {
        await guard.setGuardEnabled(false); ctx.ui.notify("Guard disabled for this Pi run.", "warning");
      } else if (command === "sandbox on") {
        await guard.setSandboxEnabled(true); ctx.ui.notify("OS sandbox enabled for this Pi run.", "success");
      } else if (command === "sandbox off") {
        await guard.setSandboxEnabled(false); ctx.ui.notify("OS sandbox disabled: Bash now has normal host filesystem and network permissions.", "warning");
      } else if (command === "dcg on") {
        await guard.setDcgEnabled(true); ctx.ui.notify("DCG enabled for this Pi run.", "success");
      } else if (command === "dcg off") {
        await guard.setDcgEnabled(false); ctx.ui.notify("DCG disabled: using the built-in Bash policy for this Pi run.", "warning");
      } else {
        ctx.ui.notify("Usage: /guard status|init|on|off|sandbox on|off|dcg on|off|read-only|workspace-write|network on|off", "warning");
      }
      updateStatus(ctx);
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || registered) return;
    sandbox = await createSandbox();
    guard = createGuardController({ cwd: ctx.cwd, sandbox, dcg: createDcgClient?.() });
    const localOps = createLocalOps();
    const guardedOps = {
      async exec(command, execCwd, options) {
        const prepared = await guard.prepareBash(command);
        return localOps.exec(prepared.command, execCwd, prepared.mode === "local" ? options : { ...options, env: { ...(options?.env ?? {}), ...(prepared.env ?? {}) } });
      },
    };
    const bashTool = createBashTool(ctx.cwd, { operations: guardedOps });
    pi.registerTool({ ...bashTool, label: "bash (guarded)", async execute(...args) { return bashTool.execute(...args); } });
    pi.registerCommand("guard", { description: "Control Pi Guard in this TUI session", getArgumentCompletions: getGuardArgumentCompletions, handler: handleCommand });
    registered = true;
    await guard.refresh();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => { if (ctx.mode === "tui") await sandbox?.reset?.(); });
  pi.on("tool_call", async (event, ctx) => {
    if (ctx.mode !== "tui" || !guard || !["read", "write", "edit", "bash"].includes(event.toolName)) return;
    const decision = await guard.handleToolCall({ toolName: event.toolName, input: event.input, ...approval(ctx) });
    updateStatus(ctx);
    if (decision.status === "block") { ctx.ui.notify(decision.reason, "warning"); return { block: true, reason: decision.reason }; }
  });
}
