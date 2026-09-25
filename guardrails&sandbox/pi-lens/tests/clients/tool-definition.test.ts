import { describe, expect, it } from "vitest";
import { normalizeToolDefinition } from "../../clients/tool-definition.js";

describe("normalizeToolDefinition", () => {
	it.each([
		["missing", undefined],
		["empty", ""],
		["whitespace", " \t\n"],
	])("supplies a description when metadata is %s", (_label, description) => {
		expect(
			normalizeToolDefinition({ name: "child_tool", description }),
		).toMatchObject({
			name: "child_tool",
			description: "Use the child_tool tool.",
		});
	});

	it("preserves a non-empty description and unrelated metadata", () => {
		const tool = {
			name: "wrapped_tool",
			description: " Wrapped path ",
			extra: true,
		};
		expect(normalizeToolDefinition(tool)).toEqual(tool);
	});

	it("falls back to a generic description when name metadata is unavailable", () => {
		expect(normalizeToolDefinition({})).toMatchObject({
			description: "Use the tool tool.",
		});
	});
});
