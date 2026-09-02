import type { ActiveView } from "../../view/stateful-view.js";
import type { VoiceState } from "../state.js";

export function selectActiveView(state: VoiceState): ActiveView {
	return state.currentScreen === "settings" ? "settings" : "dictation";
}
