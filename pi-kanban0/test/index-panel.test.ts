import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore } from "../src/board-store.js";
import { runDisplaySettings, runPanel } from "../src/index.js";
import {
  createPanelState,
  KANBAN_BOTTOM_RESERVED_ROWS,
  type PanelAction,
} from "../src/kanban-panel.js";

const createdDirectories: string[] = [];

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  strikethrough: (value: string) => value,
} as unknown as Theme;

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Kanban panel host", () => {
  it("bottom-aligns the full-width board above Pi's input area", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-kanban0-overlay-"));
    createdDirectories.push(directory);
    const path = join(directory, "board.md");
    writeFileSync(path, "# Board\n\n## Todo\n\n- [ ] Card\n", "utf8");
    const store = new BoardStore(path);
    const tui = {
      terminal: { rows: 30 },
      requestRender: () => undefined,
    } as unknown as TUI;
    let customOptions: unknown;

    const ctx = {
      ui: {
        custom: async (
          factory: (
            tui: TUI,
            theme: Theme,
            keybindings: unknown,
            done: (action: PanelAction) => void,
          ) => Component,
          options: unknown,
        ): Promise<PanelAction> => {
          customOptions = options;
          return await new Promise<PanelAction>((resolve) => {
            const component = factory(tui, theme, {}, resolve);
            component.render(100);
            component.handleInput?.("\x1b");
          });
        },
      },
    } as unknown as ExtensionCommandContext;

    await runPanel(store, createPanelState(), ctx);

    expect(customOptions).toEqual({
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        margin: { bottom: KANBAN_BOTTOM_RESERVED_ROWS },
        width: "100%",
      },
    });
  });

  it("saves display menu changes for the next open without changing the active layout", async () => {
    const state = createPanelState({ boardHeight: 20, cardRows: 2 });
    const choices = ["Card rows · 2", "Back to board"];
    const notifications: string[] = [];
    const saved: Array<{ boardHeight: "auto" | number; cardRows: number }> = [];
    const ctx = {
      ui: {
        select: async () => choices.shift(),
        input: async () => "4",
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;

    await runDisplaySettings(state, ctx, (settings) => {
      saved.push(settings);
      return settings;
    });

    expect(state.layout).toEqual({ boardHeight: 20, cardRows: 2 });
    expect(state.pendingLayout).toEqual({ boardHeight: 20, cardRows: 4 });
    expect(saved).toEqual([{ boardHeight: 20, cardRows: 4 }]);
    expect(state.message).toContain("applies next time /kanban opens");
    expect(notifications).toEqual([
      "Kanban card rows saved: 4. Close and reopen /kanban to apply.",
    ]);
  });
});
