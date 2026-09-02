import assert from "node:assert/strict";
import test from "node:test";
import { PcmChunker } from "../src/pcm-chunker.js";

test("coalesces complete frames in order and flushes the tail", () => {
  const chunks: Float32Array[] = [];
  const chunker = new PcmChunker((chunk) => chunks.push(chunk), 4);

  chunker.push(Int16Array.of(1, 2));
  chunker.push(Int16Array.of(3, 4, 5));
  chunker.push(Int16Array.of(6));

  assert.equal(chunks.length, 1);
  assert.deepEqual(
    [...chunks[0]!],
    [1, 2, 3, 4, 5].map((sample) => sample / 32_768),
  );

  chunker.flush();
  assert.equal(chunks.length, 2);
  assert.deepEqual([...chunks[1]!], [6 / 32_768]);
});

test("discard removes a partial chunk", () => {
  const chunks: Float32Array[] = [];
  const chunker = new PcmChunker((chunk) => chunks.push(chunk), 4);
  chunker.push(Int16Array.of(1, 2));
  chunker.discard();
  chunker.flush();
  assert.deepEqual(chunks, []);
});
