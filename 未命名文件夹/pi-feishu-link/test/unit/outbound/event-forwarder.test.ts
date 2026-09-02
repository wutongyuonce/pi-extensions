import test from "node:test";
import assert from "node:assert/strict";
import { EventForwarder } from "../../../src/outbound/event-forwarder.ts";
import type { ForwardConfig, RouteRef } from "../../../src/common/types.ts";

const DEFAULT_FORWARD: ForwardConfig = {
  aiReply: { mode: "card" },
  streaming: { enabled: true, throttleMs: 800 },
  toolCalls: { mode: "summary" },
  reasoning: { mode: "off" },
  progress: { enabled: true },
  reactions: { enabled: true, emojis: ["THUMBSUP"], doneEmoji: "DONE" },
};

function makeForwarder(forward: Partial<ForwardConfig> = {}) {
  let config = { ...DEFAULT_FORWARD, ...forward, streaming: { ...DEFAULT_FORWARD.streaming, ...forward.streaming }, toolCalls: { ...DEFAULT_FORWARD.toolCalls, ...forward.toolCalls }, reasoning: { ...DEFAULT_FORWARD.reasoning, ...forward.reasoning }, progress: { ...DEFAULT_FORWARD.progress, ...forward.progress } };
  const enqueued: Array<{ kind: string; dedupeKey: string; laneKey: string; text?: string }> = [];
  const deltas: string[] = [];
  const progress: string[] = [];
  const fw = new EventForwarder({
    getConfig: () => config,
    enqueue: async (partial) => {
      const p = partial.payload as { type: "text"; text: string };
      enqueued.push({ kind: partial.kind, dedupeKey: partial.dedupeKey, laneKey: partial.laneKey, text: p.text });
      return {};
    },
    liveDelta: (_, delta) => { deltas.push(delta); },
    liveContent: () => {},
    onProgress: (_, phase) => { progress.push(phase); },
  });
  const ctx = {
    key: "k",
    route: { conversationKey: "k", chatId: "oc_k", chatType: "p2p" } as RouteRef,
    sessionId: "sess-1",
    runId: "run-1",
  };
  return { fw, ctx, enqueued, deltas, progress, setConfig: (c: Partial<ForwardConfig>) => { config = { ...DEFAULT_FORWARD, ...c } as ForwardConfig; } };
}

test("text_delta routes to live channel when streaming enabled", async () => {
  const { fw, ctx, deltas } = makeForwarder();
  await fw.handle({ type: "text_delta", delta: "你", cardId: "card-1" }, ctx);
  await fw.handle({ type: "text_delta", delta: "好", cardId: "card-1" }, ctx);
  assert.deepEqual(deltas, ["你", "好"]);
});

test("streaming disabled drops deltas", async () => {
  const { fw, ctx, deltas } = makeForwarder({ streaming: { enabled: false, throttleMs: 800 } });
  await fw.handle({ type: "text_delta", delta: "x", cardId: "c" }, ctx);
  assert.equal(deltas.length, 0);
});

test("reasoning_delta only forwarded when reasoning=card", async () => {
  const { fw, ctx, deltas } = makeForwarder({ reasoning: { mode: "off" } });
  await fw.handle({ type: "reasoning_delta", delta: "think...", cardId: "c" }, ctx);
  assert.equal(deltas.length, 0);
  const { fw: fw2, ctx: ctx2, deltas: d2 } = makeForwarder({ reasoning: { mode: "card" } });
  await fw2.handle({ type: "reasoning_delta", delta: "think...", cardId: "c" }, ctx2);
  assert.equal(d2.length, 1);
});

test("tool calls: summary mode → progress line; detail mode → outbox", async () => {
  const { fw, ctx, enqueued, progress } = makeForwarder({ toolCalls: { mode: "summary" } });
  await fw.handle({ type: "tool_start", toolName: "bash", detail: "ls", runId: "r" }, ctx);
  assert.equal(progress.length, 1);
  assert.equal(enqueued.length, 0);

  const { fw: fw2, ctx: ctx2, enqueued: e2 } = makeForwarder({ toolCalls: { mode: "detail" } });
  await fw2.handle({ type: "tool_start", toolName: "bash", detail: "ls", runId: "r" }, ctx2);
  assert.equal(e2.length, 1);
  assert.equal(e2[0]?.kind, "tool");
  assert.ok(e2[0]?.text?.includes("bash"));
});

test("tool calls off → nothing", async () => {
  const { fw, ctx, enqueued, progress } = makeForwarder({ toolCalls: { mode: "off" } });
  await fw.handle({ type: "tool_start", toolName: "bash", runId: "r" }, ctx);
  assert.equal(enqueued.length, 0);
  assert.equal(progress.length, 0);
});

test("turn_end always enqueues final with dedupeKey from assistantMsgId", async () => {
  const { fw, ctx, enqueued } = makeForwarder();
  await fw.handle({ type: "turn_end", finalText: "最终回复", assistantMsgId: "msg-42" }, ctx);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.kind, "final");
  assert.equal(enqueued[0]?.dedupeKey, "final:sess-1:msg-42");
  assert.equal(enqueued[0]?.text, "最终回复");
  assert.equal(enqueued[0]?.laneKey, "k");
});
