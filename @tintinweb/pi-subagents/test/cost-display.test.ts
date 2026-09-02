/**
 * cost-display.test.ts — what `showCost` puts on each surface, and what it must
 * never put there.
 *
 * Two rules run through all of it. A cost is shown only when there is one to
 * show: a model pi has no rates for reports 0, and printing `$0.00` beside its
 * tokens would claim the run was measured and free. And each surface punctuates
 * its own — the stats line joins with `·`, the foreground result with `,`, the
 * `get_subagent_result` header with `|` — which is why the cost travels as a
 * number and is formatted at the end, not baked into the token string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const COST = 0.0123;

/** One foreground run that spends `cost` on a single assistant message. */
function runSpending(cost: number) {
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
    opts.onAssistantUsage?.({ input: 1000, output: 200, cacheWrite: 0, cost });
    return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
  });
}

const spawn = (tools: Map<string, any>) =>
  tools.get("Agent").execute(
    "tc-1",
    { prompt: "go", description: "spend", subagent_type: "general-purpose", run_in_background: false },
    undefined, undefined, ctx(),
  );

describe("cost display", () => {
  let hermetic: Hermetic;

  function boot(settings: Record<string, unknown>) {
    hermetic = hermeticDir({ settings });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registerAgents(new Map());
    hermetic?.restore();
  });

  describe("the foreground result the orchestrator reads", () => {
    it("names the cost in the stats it already reports", async () => {
      const { tools } = boot({ showCost: true });
      runSpending(COST);

      const text = textOf(await spawn(tools));

      expect(text).toContain("~$0.0123");
      // Comma-joined with the rest, not glued to the token count with the "·"
      // that the widget uses — the separator belongs to the surface.
      expect(text).toMatch(/1\.2k token, ~\$0\.0123/);
    });

    it("says nothing when the setting is off", async () => {
      const { tools } = boot({ showCost: false });
      runSpending(COST);

      expect(textOf(await spawn(tools))).not.toContain("$");
    });

    it("says nothing for a model with no pricing data", async () => {
      const { tools } = boot({ showCost: true });
      runSpending(0);

      const text = textOf(await spawn(tools));
      expect(text).toContain("1.2k token");   // tokens are still exact
      expect(text).not.toContain("$");
    });
  });

  describe("get_subagent_result", () => {
    it("reports the cost as its own labelled field", async () => {
      const { tools } = boot({ showCost: true });
      runSpending(COST);
      await spawn(tools);
      await flush();

      // The agent above ran in the foreground; look it up by the handle its
      // type gets, which is how the orchestrator would reach it.
      const text = textOf(await tools.get("get_subagent_result").execute(
        "tc-2", { agent_id: "general-purpose" }, undefined, undefined, ctx(),
      ));

      // Pipe-separated `Label: value` fields, matching its neighbours.
      expect(text).toContain("Cost: ~$0.0123");
    });

    it("omits the field entirely when unpriced", async () => {
      const { tools } = boot({ showCost: true });
      runSpending(0);
      await spawn(tools);
      await flush();

      const text = textOf(await tools.get("get_subagent_result").execute(
        "tc-2", { agent_id: "general-purpose" }, undefined, undefined, ctx(),
      ));

      expect(text).not.toContain("Cost:");
    });
  });

  describe("the background completion notification the model reads", () => {
    /**
     * The <task-notification> text sent into the parent conversation. Held
     * behind a 200ms nudge debounce (plus batch finalization), so this polls
     * rather than waiting a fixed beat.
     */
    async function notificationText(pi: any): Promise<string> {
      for (let i = 0; i < 60 && pi.sendMessage.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return pi.sendMessage.mock.calls.at(-1)?.[0]?.content ?? "";
    }

    const spawnBackground = (tools: Map<string, any>) =>
      tools.get("Agent").execute(
        "tc-1",
        { prompt: "go", description: "spend", subagent_type: "general-purpose", run_in_background: true },
        undefined, undefined, ctx(),
      );

    it("includes the cost in the usage block when enabled", async () => {
      const { pi, tools } = boot({ showCost: true, defaultJoinMode: "async" });
      runSpending(COST);

      await spawnBackground(tools);

      expect(await notificationText(pi)).toContain("<estimated_cost_usd>0.0123</estimated_cost_usd>");
    });

    it("omits it when disabled — this is LLM context, not a display", async () => {
      // A figure the orchestrator was not asked to track is one it may start
      // reporting unprompted, so the setting gates the context too, not just
      // what a human sees.
      const { pi, tools } = boot({ showCost: false, defaultJoinMode: "async" });
      runSpending(COST);

      await spawnBackground(tools);

      const text = await notificationText(pi);
      expect(text).toContain("<total_tokens>");
      expect(text).not.toContain("estimated_cost_usd");
    });

    it("omits it for a model with no pricing data", async () => {
      const { pi, tools } = boot({ showCost: true, defaultJoinMode: "async" });
      runSpending(0);

      await spawnBackground(tools);

      expect(await notificationText(pi)).not.toContain("estimated_cost_usd");
    });
  });

  describe("the completion notification", () => {
    /** Render a notification through the extension's registered renderer. */
    function render(pi: any, details: any): string {
      const [, renderer] = pi.registerMessageRenderer.mock.calls[0];
      const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
      return renderer({ details }, { expanded: false }, theme).render().join("\n");
    }

    const agent = (description: string, totalTokens: number, totalCost: number) => ({
      id: description, description, status: "completed", toolUses: 1, turnCount: 1,
      totalTokens, totalCost, durationMs: 1000, resultPreview: "done",
    });

    it("totals a group, so nobody adds four figures by hand", () => {
      const { pi } = boot({ showCost: true });
      const out = render(pi, { ...agent("first", 1000, 0.01), others: [agent("second", 3000, 0.02)] });

      expect(out).toContain("2 agents · 4.0k token · ~$0.03");
    });

    it("does not total a single agent — the line above already says it", () => {
      const { pi } = boot({ showCost: true });
      const out = render(pi, agent("only", 1000, 0.01));

      expect(out).toContain("~$0.01");
      expect(out).not.toContain("1 agents");
    });

    it("shows no total, and no per-agent cost, when unpriced", () => {
      const { pi } = boot({ showCost: true });
      const out = render(pi, { ...agent("first", 1000, 0), others: [agent("second", 3000, 0)] });

      expect(out).not.toContain("$");
    });

    it("shows nothing when the setting is off", () => {
      const { pi } = boot({ showCost: false });
      const out = render(pi, { ...agent("first", 1000, 0.01), others: [agent("second", 3000, 0.02)] });

      expect(out).not.toContain("$");
    });
  });
});
