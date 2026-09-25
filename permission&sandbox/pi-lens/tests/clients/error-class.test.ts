import { describe, expect, it } from "vitest";
import { errorClassName } from "../../clients/error-class.js";

/**
 * The ONE implementation of "an error's class name, never its message"
 * (#2451). `clients/config-warn.ts`'s `normalizeParseErrorReason({ classOnly:
 * true })`, `clients/config-core/normalize.ts`, `clients/config-core/resolve.ts`,
 * and `clients/lens-config.ts` all call this leaf instead of inlining their
 * own copy of `error instanceof Error ? error.name : "unknown error"`.
 */
describe("errorClassName (#2451)", () => {
	it("returns the constructor name for an Error instance", () => {
		expect(errorClassName(new TypeError("boom"))).toBe("TypeError");
		expect(errorClassName(new RangeError("boom"))).toBe("RangeError");
		expect(errorClassName(new Error("boom"))).toBe("Error");
	});

	it("falls back to a fixed string for anything that is not an Error instance", () => {
		expect(errorClassName("boom")).toBe("unknown error");
		expect(errorClassName(undefined)).toBe("unknown error");
		expect(errorClassName(null)).toBe("unknown error");
		expect(errorClassName({ name: "SyntaxError", message: "boom" })).toBe(
			"unknown error",
		);
	});

	it("never returns the message, even when the message could quote content", () => {
		const TOKEN = `ghp_${"C".repeat(36)}`;
		const error = new TypeError(`unexpected value ${TOKEN}`);
		const name = errorClassName(error);
		expect(name).toBe("TypeError");
		expect(name).not.toContain(TOKEN);
		expect(name).not.toContain("ghp_");
	});
});
