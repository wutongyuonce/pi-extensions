import { describe, expect, it, vi } from "vitest";
import { updateStatusBar } from "../init.ts";
import type { McpSettings } from "../types.ts";

function createState(ui: unknown, settings: Partial<McpSettings> = {}) {
  return {
    ui,
    config: { settings, mcpServers: { demo: { command: "demo" } } },
    manager: { getAllConnections: vi.fn(() => new Map()) },
  } as any;
}

describe("updateStatusBar", () => {
  it("shows enabled servers instead of active connections as the primary count", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus });

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled");
  });

  it("does not count a needs-auth connection as connected", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus });
    state.manager.getAllConnections.mockReturnValue(new Map([["demo", { status: "needs-auth" }]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled");
  });

  it("shows connected servers as secondary state", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus });
    state.manager.getAllConnections.mockReturnValue(new Map([["demo", { status: "connected" }]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled (1 connected)");
  });

  it("keeps themed status text when a theme is available", () => {
    const setStatus = vi.fn();
    const state = createState({
      setStatus,
      theme: { fg: vi.fn((_name: string, text: string) => `styled:${text}`) },
    });

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "styled:🔌 MCP: 1 server enabled");
  });

  it("keeps the icon when explicitly enabled", () => {
    const setStatus = vi.fn();
    updateStatusBar(createState({ setStatus }, { showStatusIcon: true }));

    expect(setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled");
  });

  it("removes the icon while preserving themed connected and disabled suffixes", () => {
    const setStatus = vi.fn();
    const state = createState({
      setStatus,
      theme: { fg: vi.fn((_name: string, text: string) => `styled:${text}`) },
    }, { showStatusIcon: false });
    state.config.mcpServers.disabled = { command: "disabled", disabled: true };
    state.manager.getAllConnections.mockReturnValue(new Map([[
      "demo", { status: "connected" },
    ]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "styled:MCP: 1 server enabled (1 connected) (1 disabled)");
  });
});
