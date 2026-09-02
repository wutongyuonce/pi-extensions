import { describe, expect, it } from "vitest";
import { initialVoiceState } from "../state.js";
import { draftFromConfig } from "../state-reducer.js";
import { selectActiveView } from "./focus.js";

const base = initialVoiceState(draftFromConfig({}));

describe("selectActiveView", () => {
	it("returns 'dictation' on the default state", () => {
		expect(selectActiveView(base)).toBe("dictation");
	});

	it("returns 'settings' when on the settings screen", () => {
		expect(selectActiveView({ ...base, currentScreen: "settings" })).toBe("settings");
	});
});
