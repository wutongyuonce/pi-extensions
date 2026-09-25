import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const markdown = vi.hoisted(() => ({
  createMermaidMarkdownTransformer: vi.fn(),
  prepareMermaidMarkdownRenderer: vi.fn(),
}));

vi.mock("@narumitw/pi-tui-kit/markdown", () => markdown);

import { prepareBtwTranscriptMarkdown } from "../src/transcript-markdown.js";

beforeEach(() => vi.clearAllMocks());

test("Mermaid preparation stops waiting on cancellation and handles late failure", async () => {
  let rejectPreparation: ((error: Error) => void) | undefined;
  markdown.prepareMermaidMarkdownRenderer.mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
      rejectPreparation = reject;
    }),
  );
  const controller = new AbortController();
  const preparation = prepareBtwTranscriptMarkdown([], "```mermaid\nflowchart LR\n A --> B\n```", controller.signal);
  await vi.waitFor(() => assert.equal(markdown.prepareMermaidMarkdownRenderer.mock.calls.length, 1));

  controller.abort();

  assert.equal(await preparation, undefined);
  assert.ok(rejectPreparation);
  rejectPreparation(new Error("late renderer failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("Mermaid preparation revalidates cancellation after loading the lazy module", async () => {
  let abortReads = 0;
  const signal = {
    get aborted() {
      abortReads += 1;
      return abortReads >= 3;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  const preparation = await prepareBtwTranscriptMarkdown([], "```mermaid\nflowchart LR\n A --> B\n```", signal);

  assert.equal(preparation, undefined);
  assert.equal(abortReads, 3);
  assert.equal(markdown.prepareMermaidMarkdownRenderer.mock.calls.length, 0);
});

test("Mermaid preparation revalidates cancellation after renderer preparation", async () => {
  markdown.prepareMermaidMarkdownRenderer.mockResolvedValueOnce(undefined);
  let abortReads = 0;
  const signal = {
    get aborted() {
      abortReads += 1;
      return abortReads >= 5;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  const preparation = await prepareBtwTranscriptMarkdown([], "```mermaid\nflowchart LR\n A --> B\n```", signal);

  assert.equal(preparation, undefined);
  assert.equal(abortReads, 5);
  assert.equal(markdown.prepareMermaidMarkdownRenderer.mock.calls.length, 1);
});
