import { describe, expect, it } from "vitest";
import {
	modeSuppressionNote,
	readExtensionMode,
	suppressesUserNotify,
	supportsTuiWidget,
} from "../../clients/extension-mode.js";

describe("readExtensionMode (#1334 S2)", () => {
	it("passes through the four documented host modes", () => {
		for (const mode of ["tui", "rpc", "json", "print"] as const) {
			expect(readExtensionMode({ mode })).toBe(mode);
		}
	});

	it("reports 'unknown' for a host with no mode field", () => {
		expect(readExtensionMode({})).toBe("unknown");
		expect(readExtensionMode(undefined)).toBe("unknown");
		expect(readExtensionMode(null)).toBe("unknown");
	});

	it("reports 'unknown' for an unrecognized or non-string mode", () => {
		// A future pi could add a mode; never guess a suppression for it.
		expect(readExtensionMode({ mode: "holodeck" })).toBe("unknown");
		expect(readExtensionMode({ mode: 3 })).toBe("unknown");
	});
});

describe("mode-derived behavior predicates", () => {
	it("mounts the TUI widget only in tui — and on older hosts", () => {
		expect(supportsTuiWidget("tui")).toBe(true);
		expect(supportsTuiWidget("unknown")).toBe(true);
		// rpc has hasUI:true (dialogs) but no terminal component surface.
		expect(supportsTuiWidget("rpc")).toBe(false);
		expect(supportsTuiWidget("json")).toBe(false);
		expect(supportsTuiWidget("print")).toBe(false);
	});

	it("suppresses notify chatter only in the one-shot output modes", () => {
		expect(suppressesUserNotify("print")).toBe(true);
		expect(suppressesUserNotify("json")).toBe(true);
		expect(suppressesUserNotify("tui")).toBe(false);
		expect(suppressesUserNotify("rpc")).toBe(false);
		expect(suppressesUserNotify("unknown")).toBe(false);
	});

	it("names the mode in its suppression note", () => {
		expect(modeSuppressionNote("print")).toContain("print");
	});
});
