import test from "node:test";
import assert from "node:assert/strict";
import { buildMarkdownCard, chooseMessageMode, chunkCount, splitText } from "../../../src/presentation/rich-text.ts";

test("chooseMessageMode: plain text → text, markdown → interactive", () => {
  assert.equal(chooseMessageMode("hello world"), "text");
  assert.equal(chooseMessageMode("# 标题\n内容"), "interactive");
  assert.equal(chooseMessageMode("**粗体**"), "interactive");
  assert.equal(chooseMessageMode("列表项\n- a\n- b"), "interactive");
});

test("splitText respects byte budget with CJK", () => {
  const cjk = "你好世界".repeat(100); // 400 CJK chars ≈ 1200 bytes
  const chunks = splitText(cjk, 200);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, "utf8") <= 200, `chunk ${Buffer.byteLength(c, "utf8")} > 200`);
  }
  assert.ok(chunks.length >= 5);
  assert.equal(chunks.join(""), cjk);
});

test("splitText cuts on newlines when they are near the cut window", () => {
  const text = "a".repeat(180) + "\n" + "b".repeat(1000);
  const chunks = splitText(text, 200);
  assert.ok(chunks[0]!.endsWith("\n"), "first chunk cut at newline");
  assert.equal(chunks.join(""), text);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, "utf8") <= 200);
  }
});

test("splitText handles emoji without splitting surrogates", () => {
  const emoji = "🎉".repeat(500);
  const chunks = splitText(emoji, 200);
  for (const c of chunks) {
    assert.equal(c.length % 2, 0, "no half surrogate");
  }
  assert.equal(chunks.join(""), emoji);
});

test("empty text becomes placeholder", () => {
  assert.deepEqual(splitText("   "), ["(empty response)"]);
});

test("buildMarkdownCard produces schema 2.0 with markdown body", () => {
  const card = buildMarkdownCard("## 标题\n正文") as { schema: string; body: { elements: unknown[] } };
  assert.equal(card.schema, "2.0");
  assert.ok(Array.isArray(card.body.elements));
  const el = card.body.elements[0] as { tag: string; content: string };
  assert.equal(el.tag, "markdown");
  assert.ok(el.content.includes("标题"));
});

test("chunkCount reports split count", () => {
  assert.equal(chunkCount("short"), 1);
  assert.equal(chunkCount("x".repeat(100_000), 30_000), 4);
});
