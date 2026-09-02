import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardsIn } from "../src/board-model.js";
import { BoardStore } from "../src/board-store.js";
import {
  addCard,
  addCardLabel,
  setCardTime,
  updateCardFromEditableText,
} from "../src/markdown-board.js";
import {
  createPanelState,
  KanbanPanel,
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

function fixtureStore(): BoardStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-kanban0-panel-"));
  createdDirectories.push(directory);
  const path = join(directory, "board.md");
  const source = [
    "---\nkanban-plugin: board\n---\n",
    "## Inbox\n\n- [ ] A very long first card title for narrow terminals\n\tDetails\n\tMore details\n\tThird detail\n\n- [ ] Second\n",
    "## TODO\n\n- [ ] Third\n",
    "## Doing\n\n- [ ] Fourth\n",
    "## Review\n\n",
    "## Done\n\n- [x] Fifth\n",
    "## Archive\n\n%% kanban:settings\n```\n{}\n```\n%%\n",
  ].join("");
  writeFileSync(path, source, "utf8");
  return new BoardStore(path);
}

function fakeTui(rows = 18): TUI {
  return { terminal: { rows } } as unknown as TUI;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("KanbanPanel", () => {
  it("renders within the terminal width at narrow and wide sizes", () => {
    const store = fixtureStore();
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(40), theme, () => undefined);

    for (const width of [25, 60, 120, 180]) {
      const lines = panel.render(width);
      expect(lines.length).toBeLessThanOrEqual(34);
      expect(lines.length).toBeLessThan(40);
      expect(lines[0]).toContain("PI KANBAN");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("reserves room for Pi chrome so the board header stays visible", () => {
    const store = fixtureStore();
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(10), theme, () => undefined);

    const lines = panel.render(80);

    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("PI KANBAN");
    expect(lines.at(-1)).toContain("open full keyboard help");
  });

  it("degrades below the six-row minimum without exceeding terminal space", () => {
    const store = fixtureStore();
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(7), theme, () => undefined);

    const lines = panel.render(80);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("PI KANBAN");
    expect(lines.at(-1)).toContain("q close");
  });

  it("uses complete action labels in the footer instead of compressed key groups", () => {
    const store = fixtureStore();
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(40), theme, () => undefined);

    const footer = panel.render(120).join("\n");

    expect(footer).toContain("a add card");
    expect(footer).toContain("e edit card");
    expect(footer).toContain("d delete card");
    expect(footer).toContain("c manage column");
    expect(footer).toContain("s settings (applies next time /kanban opens)");
    expect(footer).not.toContain("-/+");
    expect(footer).not.toContain("</>");
    expect(footer).toContain("? open keyboard help");
    expect(footer).not.toContain("a/e/d");
  });

  it("uses the empty right side for a second footer column on wide terminals", () => {
    const store = fixtureStore();
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(40), theme, () => undefined);

    const wide = panel.render(180);
    const divider = wide.lastIndexOf("─".repeat(180));
    const footer = wide.slice(divider + 1);

    expect(footer).toHaveLength(3);
    expect(footer[0]).toContain("Navigate:");
    expect(footer[0]).toContain("Metadata:");
    expect(footer[1]).toContain("Cards:");
    expect(footer[1]).toContain("Display:");
    expect(footer[2]).toContain("Move:");
    expect(footer[2]).toContain("Board:");
    expect(footer.every((line) => visibleWidth(line) <= 180)).toBe(true);
    expect(footer.join("\n")).not.toContain(" · ");
    expect(footer[0]).toContain("switch columns  │  ↑/↓ select cards");
    expect(footer[1]).toContain("a add card  │  e edit card");
    expect(footer[2]).toContain("between columns  │  Shift+↑/↓ reorder card");

    const regular = panel.render(120);
    const regularDivider = regular.lastIndexOf("─".repeat(120));
    const regularFooter = regular.slice(regularDivider + 1);
    expect(regularFooter).toHaveLength(6);
    expect(regularFooter[0]).not.toContain("Metadata:");
  });

  it("wraps card content across the row limit and ellipsizes only at the end", () => {
    const store = fixtureStore();
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(40), theme, () => undefined);

    const lines = panel.render(50);
    const titleRow = lines.findIndex((line) => line.includes("A very long first"));
    const continuationRow = lines.findIndex((line) => line.includes("terminals…"));
    const secondCardRow = lines.findIndex((line) => line.includes("Second"));

    expect(titleRow).toBeGreaterThan(0);
    expect(lines[titleRow]).not.toContain("…");
    expect(continuationRow).toBe(titleRow + 1);
    expect(secondCardRow).toBe(continuationRow + 1);
    expect(lines.join("\n")).not.toContain("Details");
    expect(lines.join("\n")).not.toContain("More details");
  });

  it("uses every configured row for wrapping before indicating overflow", () => {
    const store = fixtureStore();
    const card = cardsIn(store.document.columns[0]!)[0]!;
    const title = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz123";
    store.mutate((document) => {
      updateCardFromEditableText(document, card.id, title);
    });
    const state = createPanelState({ boardHeight: 20, cardRows: 3 });
    const panel = new KanbanPanel(store, state, fakeTui(40), theme, () => undefined);

    const fitting = panel.render(30);
    const fittingTitleRow = fitting.findIndex((line) => line.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
    const fittingRows = fitting.slice(fittingTitleRow, fittingTitleRow + 3);

    expect(fittingRows[1]).toContain("abcdefghijklmnopqrstuvwxyz");
    expect(fittingRows[2]).toContain("123");
    expect(fittingRows.join("\n")).not.toContain("…");

    store.mutate((document) => {
      updateCardFromEditableText(document, card.id, `${title}\nFourth line`);
    });
    const overflowing = panel.render(30);
    const overflowingTitleRow = overflowing.findIndex((line) =>
      line.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    );
    const overflowingRows = overflowing.slice(overflowingTitleRow, overflowingTitleRow + 3);

    expect(overflowingRows[1]).toContain("abcdefghijklmnopqrstuvwxyz");
    expect(overflowingRows[2]).toContain("123…");
    expect(overflowingRows.join("\n")).not.toContain("Fourth line");
  });

  it("uses the configured card row count and fixed board height", () => {
    const store = fixtureStore();
    const state = createPanelState({ boardHeight: 20, cardRows: 4 });
    const panel = new KanbanPanel(store, state, fakeTui(40), theme, () => undefined);

    const lines = panel.render(50);
    const titleRow = lines.findIndex((line) => line.includes("A very long first"));
    const secondCardRow = lines.findIndex((line) => line.includes("Second"));

    expect(lines).toHaveLength(20);
    expect(lines[titleRow + 1]).toContain("terminals");
    expect(lines[titleRow + 2]).toContain("Details");
    expect(lines[titleRow + 3]).toContain("More details…");
    expect(lines.join("\n")).not.toContain("Third detail");
    expect(secondCardRow).toBe(titleRow + 4);
  });

  it("does not bind direct keys to display changes", () => {
    const store = fixtureStore();
    const state = createPanelState({ boardHeight: 20, cardRows: 2 });
    const panel = new KanbanPanel(store, state, fakeTui(40), theme, () => undefined);
    const before = panel.render(50);

    for (const key of ["-", "_", "+", "=", "<", ">"] as const) {
      panel.handleInput(key);
    }

    expect(panel.render(50)).toEqual(before);
    expect(state.layout).toEqual({ boardHeight: 20, cardRows: 2 });
    expect(state.pendingLayout).toEqual({ boardHeight: 20, cardRows: 2 });
  });

  it("includes @ time and # labels in the second item row when space permits", () => {
    const store = fixtureStore();
    const card = cardsIn(store.document.columns[0]!)[1]!;
    store.mutate((document) => {
      updateCardFromEditableText(document, card.id, "Second\nDetails");
      setCardTime(document, card.id, "2026-08-04 09:30");
      addCardLabel(document, card.id, "urgent");
    });
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(40), theme, () => undefined);

    const output = panel.render(50).join("\n");

    expect(output).toContain("Details · @ 2026-08-04 09:30 · #urgent");
  });

  it("caps a tall board and keeps its cards scrollable", () => {
    const store = fixtureStore();
    store.mutate((document) => {
      for (let index = 0; index < 30; index += 1) addCard(document, 0, `Extra ${index + 1}`);
    });
    const state = createPanelState();
    const panel = new KanbanPanel(store, state, fakeTui(40), theme, () => undefined);

    const tallBoard = panel.render(100);
    expect(tallBoard.length).toBeGreaterThan(17);
    expect(tallBoard.length).toBeLessThanOrEqual(34);
    panel.handleInput("\x1b[6~");
    expect(state.selectedCards[0]).toBeGreaterThan(0);
    expect(panel.render(100)[0]).toContain("PI KANBAN");
  });

  it("keeps help and detail views keyboard-only and width-safe", () => {
    const store = fixtureStore();
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(16), theme, () => undefined);

    panel.handleInput("?");
    const help = panel.render(48);
    expect(help.length).toBeLessThanOrEqual(12);
    expect(help.every((line) => visibleWidth(line) <= 48)).toBe(true);
    panel.handleInput("?");
    panel.handleInput("\r");
    const detail = panel.render(48);
    expect(detail.length).toBeLessThanOrEqual(12);
    expect(detail.every((line) => visibleWidth(line) <= 48)).toBe(true);
    expect(detail.join("\n")).not.toContain("Navigate:");
    expect(detail.join("\n")).toContain("y copy card");
    panel.handleInput("\x1b");
    expect(panel.render(48)[0]).toContain("PI KANBAN");
  });

  it("copies the open card without time or labels and keeps the detail view open", async () => {
    const store = fixtureStore();
    const card = cardsIn(store.document.columns[0]!)[0]!;
    store.mutate((document) => {
      setCardTime(document, card.id, "2026-08-04 09:30");
      addCardLabel(document, card.id, "urgent");
    });
    let copied = "";
    let renders = 0;
    const tui = {
      terminal: { rows: 24 },
      requestRender: () => {
        renders += 1;
      },
    } as unknown as TUI;
    const panel = new KanbanPanel(
      store,
      createPanelState(),
      tui,
      theme,
      () => undefined,
      async (text) => {
        copied = text;
      },
    );

    panel.handleInput("\r");
    panel.handleInput("y");
    await Promise.resolve();

    expect(copied).toBe([
      "A very long first card title for narrow terminals",
      "Details",
      "More details",
      "Third detail",
    ].join("\n"));
    expect(copied).not.toContain("2026-08-04 09:30");
    expect(copied).not.toContain("urgent");
    expect(renders).toBe(1);
    expect(panel.render(80).join("\n")).toContain("Copied card to clipboard");
  });

  it("copies the selected card from the board without time or labels", async () => {
    const store = fixtureStore();
    const card = cardsIn(store.document.columns[0]!)[0]!;
    store.mutate((document) => {
      setCardTime(document, card.id, "2026-08-04 09:30");
      addCardLabel(document, card.id, "urgent");
    });
    const state = createPanelState();
    let copied = "";
    let renders = 0;
    const tui = {
      terminal: { rows: 24 },
      requestRender: () => {
        renders += 1;
      },
    } as unknown as TUI;
    const panel = new KanbanPanel(
      store,
      state,
      tui,
      theme,
      () => undefined,
      async (text) => {
        copied = text;
      },
    );

    panel.handleInput("y");
    await Promise.resolve();

    expect(state.view).toBe("board");
    expect(copied).toBe([
      "A very long first card title for narrow terminals",
      "Details",
      "More details",
      "Third detail",
    ].join("\n"));
    expect(copied).not.toContain("2026-08-04 09:30");
    expect(copied).not.toContain("urgent");
    expect(renders).toBe(1);
    expect(panel.render(80).join("\n")).toContain("Copied card to clipboard");
  });

  it("restores the card detail after a label or time dialog is cancelled", () => {
    const store = fixtureStore();
    const state = createPanelState();
    const actions: PanelAction[] = [];
    const panel = new KanbanPanel(store, state, fakeTui(), theme, (action) => actions.push(action));

    panel.handleInput("\r");
    panel.handleInput("#");
    expect(actions.at(-1)?.type).toBe("label");
    expect(state.view).toBe("detail");

    const afterCancelledDialog = new KanbanPanel(
      store,
      state,
      fakeTui(),
      theme,
      (action) => actions.push(action),
    );
    expect(afterCancelledDialog.render(80)[0]).toContain("CARD");
    afterCancelledDialog.handleInput("@");
    expect(actions.at(-1)?.type).toBe("time");
    expect(state.view).toBe("detail");
  });

  it("returns from help to the detail view that opened it", () => {
    const store = fixtureStore();
    const state = createPanelState();
    const panel = new KanbanPanel(store, state, fakeTui(), theme, () => undefined);

    panel.handleInput("\r");
    panel.handleInput("?");
    expect(state.view).toBe("help");
    panel.handleInput("\x1b");

    expect(state.view).toBe("detail");
    expect(panel.render(80)[0]).toContain("CARD");
  });

  it("reuses card wrapping work when the first move redraws the board", () => {
    const store = fixtureStore();
    const state = createPanelState();
    const movedCardId = cardsIn(store.document.columns[0]!)[0]!.id;
    const wrapCardText = vi.fn(wrapTextWithAnsi);
    const panel = new KanbanPanel(
      store,
      state,
      fakeTui(40),
      theme,
      () => undefined,
      async () => undefined,
      wrapCardText,
    );

    panel.render(129);
    const initialWrapCount = wrapCardText.mock.calls.length;
    expect(initialWrapCount).toBeGreaterThan(0);

    panel.handleInput("\x1b[1;2C");
    panel.render(129);

    expect(wrapCardText).toHaveBeenCalledTimes(initialWrapCount);

    const movedCard = cardsIn(store.document.columns[1]!).find(
      (card) => card.id === movedCardId,
    )!;
    store.mutate((document) => {
      updateCardFromEditableText(document, movedCard.id, "Updated after move");
    });
    expect(panel.render(129).join("\n")).toContain("Updated after move");
    expect(wrapCardText.mock.calls.length).toBeGreaterThan(initialWrapCount);
  });

  it("toggles and moves the selected card with single-key actions", () => {
    const store = fixtureStore();
    const state = createPanelState();
    state.message = "Old status";
    state.messageKind = "warning";
    const panel = new KanbanPanel(store, state, fakeTui(), theme, () => undefined);
    const firstId = cardsIn(store.document.columns[0]!)[0]!.id;

    panel.handleInput(" ");
    expect(cardsIn(store.document.columns[0]!)[0]?.checked).toBe(true);
    expect(state.message).toBeUndefined();
    panel.handleInput("]");
    expect(cardsIn(store.document.columns[1]!).map((card) => card.id)).toContain(firstId);
    expect(state.selectedColumn).toBe(1);
  });

  it("returns explicit actions for text entry and closing", () => {
    const store = fixtureStore();
    const actions: PanelAction[] = [];
    const panel = new KanbanPanel(store, createPanelState(), fakeTui(), theme, (action) => actions.push(action));

    panel.handleInput("a");
    expect(actions[0]).toEqual({ type: "add", columnIndex: 0 });

    panel.handleInput("c");
    expect(actions[1]).toEqual({ type: "column", columnIndex: 0 });

    panel.handleInput("@");
    expect(actions[2]).toEqual({ type: "time", cardId: cardsIn(store.document.columns[0]!)[0]!.id });

    panel.handleInput("#");
    expect(actions[3]).toEqual({ type: "label", cardId: cardsIn(store.document.columns[0]!)[0]!.id });

    panel.handleInput("s");
    expect(actions[4]).toEqual({ type: "settings" });

    const closing = new KanbanPanel(store, createPanelState(), fakeTui(), theme, (action) => actions.push(action));
    closing.handleInput("q");
    expect(actions.at(-1)).toEqual({ type: "close" });
  });
});
