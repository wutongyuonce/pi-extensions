import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SHORTCUT, normalizeShortcut } from "./shortcut-core.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the setting Pi needs while synchronously registering the extension. */
export function readShortcutForRegistration(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(getAgentDir(), "pi-transcribe.json"), "utf8"),
    );
    if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.shortcut !== "string") {
      return DEFAULT_SHORTCUT;
    }
    return normalizeShortcut(parsed.shortcut) ?? DEFAULT_SHORTCUT;
  } catch {
    return DEFAULT_SHORTCUT;
  }
}
