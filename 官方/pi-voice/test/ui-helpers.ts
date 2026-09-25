import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type TUI,
} from "@earendil-works/pi-tui";

/** A theme whose styling functions return their text unchanged. */
export function testTheme(): ExtensionContext["ui"]["theme"] {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  } as unknown as ExtensionContext["ui"]["theme"];
}

export function testTui(rows?: number): TUI {
  return {
    requestRender() {},
    ...(rows === undefined ? {} : { terminal: { rows, columns: 80 } }),
  } as unknown as TUI;
}

export function keybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS);
}
