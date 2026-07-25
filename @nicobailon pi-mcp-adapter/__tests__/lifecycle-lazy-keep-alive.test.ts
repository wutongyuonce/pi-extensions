import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyConnect } from "../init.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { executeCall } from "../proxy-modes.ts";
import { reconnectServers } from "../commands.ts";
import type { ServerDefinition } from "../types.ts";

interface FakeConnection {
  status: "connected" | "closed" | "needs-auth";
}

class FakeManager {
  connections = new Map<string, FakeConnection>();
  connectCalls: string[] = [];
  closeCalls: string[] = [];
  idleResponses = new Map<string, boolean>();
  connectError: Error | undefined;

  setConnection(name: string, status: FakeConnection["status"] | null): void {
    if (status === null) {
      this.connections.delete(name);
    } else {
      this.connections.set(name, { status });
    }
  }

  getConnection(name: string): FakeConnection | undefined {
    return this.connections.get(name);
  }

  async connect(name: string): Promise<FakeConnection> {
    this.connectCalls.push(name);
    if (this.connectError) throw this.connectError;
    const connection: FakeConnection = { status: "connected" };
    this.connections.set(name, connection);
    return connection;
  }

  async close(name: string): Promise<void> {
    this.closeCalls.push(name);
    this.connections.delete(name);
  }

  isIdle(name: string): boolean {
    return this.idleResponses.get(name) ?? false;
  }
}

function makeDefinition(lifecycle: ServerDefinition["lifecycle"]): ServerDefinition {
  return { command: "echo", args: [], lifecycle };
}

describe("lazy-keep-alive lifecycle", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempAgentDir: string;
  let fake: FakeManager;
  let lifecycle: McpLifecycleManager;

  beforeEach(() => {
    tempAgentDir = mkdtempSync(join(tmpdir(), "pi-mcp-lifecycle-"));
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
    fake = new FakeManager();
    lifecycle = new McpLifecycleManager(fake as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(tempAgentDir, { recursive: true, force: true });
  });

  it("does not install a health interval for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    lifecycle.startHealthChecks(controller.signal, 1000);
    expect((lifecycle as any).healthCheckInterval).toBeUndefined();
  });

  it("consumes health-check rejections without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const def = makeDefinition("lazy");
    lifecycle.registerServer("srv", def, { idleTimeout: 1 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);
    fake.close = vi.fn(async () => { throw new Error("idle close failed \u001b]52;c;secret\u0007"); });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      lifecycle.startHealthChecks(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith("MCP: Health check failed: idle close failed");
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      await lifecycle.gracefulShutdown().catch(() => {});
    }
  });

  it("reconnects after first spawn when the process dies", async () => {
    const def = makeDefinition("lazy-keep-alive");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });

    lifecycle.startHealthChecks(1000);
    await Promise.resolve();
    expect(fake.connectCalls).not.toContain("srv");

    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected");

    fake.setConnection("srv", null);
    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.connectCalls).toContain("srv");
  });

  it("records reconnect failures and clears them after a later success", async () => {
    const def = makeDefinition("keep-alive");
    lifecycle.markKeepAlive("srv", def);
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    lifecycle.setReconnectFailureCallback(onFailure);
    lifecycle.setReconnectCallback(onSuccess);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.connectError = new Error("server exited \x1b]52;c;clipboard-secret\x07safely");

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(onFailure).toHaveBeenCalledWith("srv", fake.connectError);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("MCP: Failed to reconnect to srv: server exited safely");
    expect(consoleError.mock.calls[0][0]).not.toContain("clipboard-secret");

    fake.connectError = undefined;
    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(onSuccess).toHaveBeenCalledWith("srv");
  });

  it("does not reconnect keep-alive servers while OAuth authorization is pending", async () => {
    const def = makeDefinition("keep-alive");
    lifecycle = new McpLifecycleManager(fake as never, name => name === "srv");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "needs-auth");

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.connectCalls).not.toContain("srv");
  });

  it("never idle-shuts a server registered with idleTimeout 0", async () => {
    const def = makeDefinition("lazy-keep-alive");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.closeCalls).not.toContain("srv");
  });

  it("idle-shuts a plain lazy server past its timeout", async () => {
    const def = makeDefinition("lazy");
    lifecycle.registerServer("srv", def, { idleTimeout: 1 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.closeCalls).toContain("srv");
  });

  it("marks lazyConnect first spawns for health-check reconnects", async () => {
    const connection = {
      status: "connected" as const,
      tools: [],
      resources: [],
    };
    let current: typeof connection | undefined;
    const manager = {
      getConnection: vi.fn(() => current),
      getAllConnections: vi.fn(() => current ? new Map([["srv", current]]) : new Map()),
      connect: vi.fn(async () => {
        current = connection;
        return connection;
      }),
      isIdle: vi.fn(() => false),
    };
    const setStatus = vi.fn();
    const state = {
      config: { settings: { showStatusIcon: false }, mcpServers: { srv: makeDefinition("lazy-keep-alive") } },
      manager,
      lifecycle: new McpLifecycleManager(manager as never),
      ui: { setStatus },
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
    } as never;

    await lazyConnect(state, "srv");
    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: connecting to srv...");
    current = undefined;
    await (state as any).lifecycle.checkConnections();

    expect(manager.connect).toHaveBeenCalledTimes(2);
  });

  it("marks cached proxy first-use connects for health-check reconnects", async () => {
    const connection = {
      status: "connected" as const,
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
      resources: [],
      client: { callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
    };
    let current: typeof connection | undefined;
    const manager = {
      getConnection: vi.fn(() => current),
      connect: vi.fn(async () => {
        current = connection;
        return connection;
      }),
      isIdle: vi.fn(() => false),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    };
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { srv: makeDefinition("lazy-keep-alive") } },
      manager,
      lifecycle: new McpLifecycleManager(manager as never),
      toolMetadata: new Map([["srv", [{ name: "srv_search", originalName: "search", description: "Search" }]]]),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as never;

    const result = await executeCall(state, "srv_search", {}, "srv");
    expect(result.content[0]?.text).toBe("ok");

    current = undefined;
    await (state as any).lifecycle.checkConnections();

    expect(manager.connect).toHaveBeenCalledTimes(2);
  });

  it("marks manual reconnects for lazy-keep-alive servers", async () => {
    const connection = {
      status: "connected" as const,
      tools: [],
      resources: [],
    };
    let current: typeof connection | undefined;
    const manager = {
      close: vi.fn(async () => {
        current = undefined;
      }),
      getConnection: vi.fn(() => current),
      connect: vi.fn(async () => {
        current = connection;
        return connection;
      }),
      isIdle: vi.fn(() => false),
    };
    const state = {
      config: { settings: {}, mcpServers: { srv: makeDefinition("lazy-keep-alive") } },
      manager,
      lifecycle: new McpLifecycleManager(manager as never),
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
    } as never;

    await reconnectServers(state, { hasUI: false } as never, "srv");
    current = undefined;
    await (state as any).lifecycle.checkConnections();

    expect(manager.connect).toHaveBeenCalledTimes(2);
  });
});
