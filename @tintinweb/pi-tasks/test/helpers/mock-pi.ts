/**
 * Shared test harness: a minimal fake ExtensionAPI plus a fake @tintinweb/pi-subagents
 * extension, so tests can drive src/index.ts without a real pi session.
 */

import { vi } from "vitest";

export type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

/** Let queued microtasks and immediates run — event handlers in src/index.ts are async
 *  but the emitter calls them synchronously, so awaiting a tick is how a test observes
 *  their effects. */
export function flush(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/** Minimal mock of ExtensionAPI with events, tool capture, and event hooks. */
export function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        // Copy first — handlers commonly unsubscribe themselves while dispatching.
        for (const h of [...(eventHandlers.get(channel) ?? [])]) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    /** Execute a registered tool by name. */
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    /** Execute a registered tool with an abort signal. */
    async executeToolWithSignal(name: string, params: any, signal: AbortSignal, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, signal, undefined, ctx ?? mockCtx());
    },
    /** Run a registered command's handler. */
    async runCommand(name: string, args: string, ctx: any) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command ${name} not registered`);
      return cmd.handler(args, ctx);
    },
    /** Fire lifecycle event handlers (turn_start, tool_result, etc.) */
    async fireLifecycle(event: string, ...args: any[]) {
      const results: any[] = [];
      for (const h of lifecycleHandlers.get(event) ?? []) {
        results.push(await h(...args));
      }
      return results;
    },
    /** Emit an event on pi.events (simulates subagent extension). */
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
  };
}

export type MockPi = ReturnType<typeof mockPi>;

/** Minimal mock ExtensionContext. */
export function mockCtx(cwd = process.cwd()) {
  return {
    // Task paths resolve against the session workspace, not the host process cwd.
    cwd,
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

/**
 * Mock ExtensionContext carrying a session ID, for session_start handling.
 *
 * `getSessionFile` mirrors pi: a persisted session has one, and a session pi is not
 * persisting (`pi --no-session`, `SessionManager.inMemory()`) reports a session ID
 * but no file. Pass `{ persisted: false }` for the latter.
 */
export function mockSessionCtx(sessionId: string, opts?: { persisted?: boolean; cwd?: string }) {
  const sessionFile = opts?.persisted === false ? undefined : `/sessions/${sessionId}.jsonl`;
  return {
    ...mockCtx(opts?.cwd),
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
      getSessionFile: vi.fn(() => sessionFile),
    },
  };
}

/**
 * Simulates the @tintinweb/pi-subagents extension: answers the ping, spawn, stop and
 * consume RPCs, emits ready, and settles agents the way the real extension does.
 *
 * `settle()` mirrors pi-subagents' completion path, which is what makes the
 * duplicate-follow-up behaviour testable: the lifecycle event fires first, then the
 * completion notification is *held* briefly (200 ms upstream, `NUDGE_HOLD_MS`) and
 * sent only if nothing marked the result consumed while it waited. A held nudge
 * lands in `notified`; each entry there costs the parent an extra model turn.
 */
export function installSubagentsMock(
  pi: { events: MockEventBus },
  opts?: { spawnError?: string; version?: number; withoutConsume?: boolean },
) {
  let idCounter = 0;
  const spawned: Array<{ id: string; type: string; prompt: string; options: any }> = [];
  const stopped: string[] = [];
  const consumed: string[] = [];
  const notified: string[] = [];

  // Respond to ping — reply on scoped channel
  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: opts?.version ?? 2 } });
  });

  // Respond to spawn — reply on scoped channel
  const unsubSpawn = pi.events.on("subagents:rpc:spawn", (data: unknown) => {
    const { requestId, type, prompt, options } = data as {
      requestId: string; type: string; prompt: string; options?: any;
    };
    if (opts?.spawnError) {
      pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: false, error: opts.spawnError });
      return;
    }
    const id = `agent-${++idCounter}`;
    spawned.push({ id, type, prompt, options });
    pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id } });
  });

  // Respond to stop — reply on scoped channel
  const unsubStop = pi.events.on("subagents:rpc:stop", (data: unknown) => {
    const { requestId, agentId } = data as { requestId: string; agentId: string };
    const known = spawned.some(s => s.id === agentId);
    if (known) {
      stopped.push(agentId);
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    } else {
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false, error: "Agent not found" });
    }
  });

  // Respond to consume — reply on scoped channel. `withoutConsume` stands in for a
  // pi-subagents from before the channel existed, which leaves it unanswered.
  const unsubConsume = opts?.withoutConsume ? () => {} : pi.events.on("subagents:rpc:consume", (data: unknown) => {
    const { requestId, agentId } = data as { requestId: string; agentId: string };
    const known = spawned.some(s => s.id === agentId);
    if (known) {
      consumed.push(agentId);
      pi.events.emit(`subagents:rpc:consume:reply:${requestId}`, { success: true });
    } else {
      pi.events.emit(`subagents:rpc:consume:reply:${requestId}`, { success: false, error: "Agent not found" });
    }
  });

  // Broadcast readiness
  pi.events.emit("subagents:ready", {});

  /** Stand-in for pi-subagents' 200 ms NUDGE_HOLD_MS — a real timer, kept short. */
  const NUDGE_HOLD_MS = 20;

  function settle(channel: "subagents:completed" | "subagents:failed", agentId: string, data: Record<string, unknown>) {
    pi.events.emit(channel, { id: agentId, ...data });
    setTimeout(() => { if (!consumed.includes(agentId)) notified.push(agentId); }, NUDGE_HOLD_MS);
  }

  return {
    spawned,
    stopped,
    consumed,
    notified,
    /** Agent finished successfully. */
    complete(agentId: string, result?: string) { settle("subagents:completed", agentId, { result }); },
    /** Agent failed (or was stopped, with `status: "stopped"`). */
    fail(agentId: string, error: string, status = "error") { settle("subagents:failed", agentId, { error, status }); },
    /** Wait past the notification hold, so `notified` is final. */
    afterNudgeHold() { return new Promise<void>(resolve => setTimeout(resolve, NUDGE_HOLD_MS * 2)); },
    unsub() { unsubPing(); unsubSpawn(); unsubStop(); unsubConsume(); },
  };
}
