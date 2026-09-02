/**
 * mention-start-notification.test.ts — does an agent STARTED by a mention
 * report back to the main conversation?
 *
 * The resume path is pinned in agent-mention-wiring.test.ts ("relays the
 * resumed answer through the ordinary completion notification"). The start path
 * — `@handle msg` naming a type with no live instance — has no equivalent, and
 * it is the path every first mention takes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { runMentionClone } from "../src/mention-clone.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.mocked(runMentionClone).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

const send = (lifecycle: Map<string, any>, text: string) =>
  lifecycle.get("input")({ type: "input", text, source: "interactive" }, ctx());

describe("an agent started by a mention", () => {
  it("relays its answer through the ordinary completion notification (direct mode)", async () => {
    const { pi, lifecycle } = boot({ agentMentions: "direct" });
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "found four planted bugs",
      session: fakeSession(),
      aborted: false,
      steered: false,
      failure: undefined,
    } as any);

    await send(lifecycle, "@Explore find the planted bugs in src/");
    await new Promise(r => setTimeout(r, 500));

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("found four planted bugs"),
      }),
      expect.objectContaining({ triggerTurn: true }),
    );
  });

  it("relays it when the clone fell back to a direct start (model mode)", async () => {
    // What the user hits today: the clone reports it could not start the agent,
    // index.ts starts it directly, and the answer still has to come back.
    const { pi, lifecycle } = boot();
    vi.mocked(runMentionClone).mockResolvedValue({ spawned: false, error: "the conversation clone did not start it" });
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "cyan, obviously",
      session: fakeSession(),
      aborted: false,
      steered: false,
      failure: undefined,
    } as any);

    await send(lifecycle, "@Explore whats your favorite color");
    await new Promise(r => setTimeout(r, 500));

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("cyan, obviously"),
      }),
      expect.objectContaining({ triggerTurn: true }),
    );
  });
});
