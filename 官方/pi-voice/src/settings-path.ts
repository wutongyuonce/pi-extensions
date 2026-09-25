import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const SETTINGS_FILENAME = "pi-voice.json";
export const LEGACY_SETTINGS_FILENAME = "pi-transcribe.json";

export function settingsPath(): string {
  return join(getAgentDir(), SETTINGS_FILENAME);
}

export function legacySettingsPath(): string {
  return join(getAgentDir(), LEGACY_SETTINGS_FILENAME);
}
