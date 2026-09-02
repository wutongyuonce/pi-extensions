import { describe, expect, it } from "vitest";
import {
	detectIndentation,
	hasDetectableIndentation,
} from "../../../clients/dispatch/indent-detect.js";

describe("indentation detection", () => {
	it.each([
		["\tone\n\t\ttwo\n", { style: "tab", width: 1 }],
		["  one\n    two\n", { style: "space", width: 2 }],
		["    one\n        two\n", { style: "space", width: 4 }],
		["   one\n", { style: "space", width: 3 }],
	])("detects %s", (content, expected) => {
		expect(detectIndentation(content)).toEqual(expected);
		expect(hasDetectableIndentation(content)).toBe(true);
	});

	it("chooses the majority style in mixed content", () => {
		expect(detectIndentation("  one\n    two\n\tthree\n")).toEqual({
			style: "space",
			width: 2,
		});
	});

	it.each(["", "const x = 1;\n"])("uses a safe default for %s", (content) => {
		expect(detectIndentation(content)).toEqual({ style: "space", width: 2 });
		expect(hasDetectableIndentation(content)).toBe(false);
	});
});
