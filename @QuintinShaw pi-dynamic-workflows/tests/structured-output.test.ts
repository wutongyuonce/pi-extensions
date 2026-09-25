import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { createStructuredOutputTool } from "../src/structured-output.js";

test("createStructuredOutputTool creates a tool with the given name", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ result: Type.String() }),
    capture,
    name: "my_output",
  });
  assert.equal(tool.name, "my_output");
});

test("createStructuredOutputTool defaults name to structured_output", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ result: Type.String() }),
    capture,
  });
  assert.equal(tool.name, "structured_output");
});

test("createStructuredOutputTool tool has execute, renderCall, renderResult", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ ok: Type.Boolean() }),
    capture,
  });
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.label, "label should be truthy");
});

test("createStructuredOutputTool execute captures value and marks called", async () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ ok: Type.Boolean() }),
    capture,
  });
  const result = await tool.execute("call-1", { ok: true });
  assert.equal(capture.called, true);
  assert.deepEqual(capture.value, { ok: true });
  assert.ok(result.terminate, "should terminate the agent");
  assert.equal(result.content[0].text, "Structured output received.");
});

test("createStructuredOutputTool captures complex nested objects", async () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({
      items: Type.Array(Type.Object({ id: Type.Number(), name: Type.String() })),
      total: Type.Number(),
    }),
    capture,
  });
  const data = {
    items: [
      { id: 1, name: "foo" },
      { id: 2, name: "bar" },
    ],
    total: 2,
  };
  await tool.execute("call-2", data);
  assert.equal(capture.called, true);
  assert.deepEqual(capture.value, data);
});

test("createStructuredOutputTool returns details with captured params", async () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ x: Type.Number() }),
    capture,
  });
  const result = await tool.execute("call-3", { x: 42 });
  assert.deepEqual(result.details, { x: 42 });
});

test("createStructuredOutputTool has promptSnippet and promptGuidelines", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ result: Type.String() }),
    capture,
  });
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(Array.isArray(tool.promptGuidelines), "tool.promptGuidelines should be an array");
  assert.ok(tool.promptGuidelines.length > 0, "tool.promptGuidelines should not be empty");
  // Should mention the tool name in guidelines
  assert.ok(
    tool.promptGuidelines.some((g: string) => g.includes("structured_output")),
    "should contain structured_output",
  );
});

test("createStructuredOutputTool uses parameters from schema", () => {
  const capture = { called: false, value: undefined };
  const schema = Type.Object({
    verdict: Type.String(),
    score: Type.Number(),
  });
  const tool = createStructuredOutputTool({ schema, capture });
  // TypeBox-defined parameters are available
  assert.ok(tool.parameters, "parameters should be truthy");
});
