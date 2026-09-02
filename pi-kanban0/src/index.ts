import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cardsIn } from "./board-model.js";
import {
  addCard,
  addCardLabel,
  cardToEditableText,
  deleteCard,
  findCard,
  readCardMetadata,
  setCardTime,
  updateCardFromEditableText,
} from "./markdown-board.js";
import { addColumn, deleteColumn, moveColumn, renameColumn } from "./markdown-board.js";
import { BoardConflictError, BoardStore } from "./board-store.js";
import { registerKanbanTool } from "./kanban-tool.js";
import {
  createPanelState,
  KANBAN_BOTTOM_RESERVED_ROWS,
  KanbanPanel,
  type PanelAction,
  type PanelState,
} from "./kanban-panel.js";
import {
  defaultKanbanLayout,
  loadKanbanLayout,
  MAX_BOARD_HEIGHT,
  MAX_CARD_ROWS,
  MIN_BOARD_HEIGHT,
  MIN_CARD_ROWS,
  normalizeKanbanLayout,
  saveKanbanLayout,
  type KanbanLayoutSettings,
} from "./kanban-settings.js";
import {
  type BoardScope,
  ensureScopedBoard,
  globalBoardPath,
  importScopedBoard,
  projectBoardPath,
  resolveImportPath,
  type ScopedBoardLocation,
} from "./project-board.js";
import { cardTimeShortcuts } from "./time-shortcuts.js";

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function usableFile(path: string | undefined): path is string {
  if (!path || !existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function chooseBoardLocation(
  ctx: ExtensionCommandContext,
  explicitScope?: BoardScope,
  agentDir?: string,
): Promise<ScopedBoardLocation | undefined> {
  if (explicitScope) return ensureScopedBoard(explicitScope, ctx.cwd, agentDir);

  const projectPath = projectBoardPath(ctx.cwd);
  if (usableFile(projectPath)) {
    return { path: projectPath, created: false, scope: "project" };
  }

  const globalPath = globalBoardPath(agentDir);
  if (usableFile(globalPath)) {
    return { path: globalPath, created: false, scope: "global" };
  }

  const projectOption = "Project board · create .pi/kanban.md here";
  const globalOption = "Global board · create one for all projects";
  const choice = await ctx.ui.select("Choose Kanban scope", [projectOption, globalOption]);
  if (!choice) return undefined;
  return ensureScopedBoard(choice === projectOption ? "project" : "global", ctx.cwd, agentDir);
}

export async function chooseImportLocation(
  ctx: ExtensionCommandContext,
  agentDir?: string,
): Promise<ScopedBoardLocation | undefined> {
  const projectPath = projectBoardPath(ctx.cwd);
  if (usableFile(projectPath)) {
    return { path: projectPath, created: false, scope: "project" };
  }

  const globalPath = globalBoardPath(agentDir);
  if (usableFile(globalPath)) {
    return { path: globalPath, created: false, scope: "global" };
  }

  const projectOption = "Project board · import into .pi/kanban.md here";
  const globalOption = "Global board · import for all projects";
  const choice = await ctx.ui.select("Choose import destination", [projectOption, globalOption]);
  if (!choice) return undefined;
  return choice === projectOption
    ? { path: projectPath, created: true, scope: "project" }
    : { path: globalPath, created: true, scope: "global" };
}

function mutationError(ctx: ExtensionCommandContext, state: PanelState, error: unknown): void {
  if (error instanceof BoardConflictError) {
    state.message = "Board changed on disk — press r to reload";
    state.messageKind = "warning";
    ctx.ui.notify("The board changed outside this panel. Press r in the reopened board to load it.", "warning");
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  state.message = message;
  state.messageKind = "error";
  ctx.ui.notify(message, "error");
}

function clearStatus(state: PanelState): void {
  state.message = undefined;
  state.messageKind = undefined;
}

function moveIndexedState(values: number[], from: number, to: number): void {
  const [value] = values.splice(from, 1);
  values.splice(to, 0, value ?? 0);
}

async function runColumnMenu(
  store: BoardStore,
  state: PanelState,
  ctx: ExtensionCommandContext,
  columnIndex: number,
): Promise<void> {
  const column = store.document.columns[columnIndex];
  if (!column) return;

  const options = ["Add column after", "Rename column"];
  if (columnIndex > 0) options.push("Move column left");
  if (columnIndex < store.document.columns.length - 1) options.push("Move column right");
  if (store.document.columns.length > 1) options.push("Delete column");
  const choice = await ctx.ui.select(`Column · ${column.title}`, options);
  if (!choice) return;

  if (choice === "Add column after") {
    const title = await ctx.ui.input("Add column", "Column title");
    if (!title?.trim()) return;
    try {
      store.mutate((document) => addColumn(document, title, columnIndex));
      const target = columnIndex + 1;
      state.selectedCards.splice(target, 0, 0);
      state.cardOffsets.splice(target, 0, 0);
      state.selectedColumn = target;
      clearStatus(state);
    } catch (error) {
      mutationError(ctx, state, error);
    }
    return;
  }

  if (choice === "Rename column") {
    const title = await ctx.ui.input("Rename column", column.title);
    if (!title?.trim()) return;
    try {
      store.mutate((document) => renameColumn(document, columnIndex, title));
      clearStatus(state);
    } catch (error) {
      mutationError(ctx, state, error);
    }
    return;
  }

  if (choice === "Move column left" || choice === "Move column right") {
    const target = columnIndex + (choice.endsWith("left") ? -1 : 1);
    try {
      store.mutate((document) => moveColumn(document, columnIndex, target));
      moveIndexedState(state.selectedCards, columnIndex, target);
      moveIndexedState(state.cardOffsets, columnIndex, target);
      state.selectedColumn = target;
      clearStatus(state);
    } catch (error) {
      mutationError(ctx, state, error);
    }
    return;
  }

  if (choice === "Delete column") {
    const count = cardsIn(column).length;
    const detail = count > 0
      ? `“${column.title}” contains ${count} card(s). They will also be deleted.`
      : `“${column.title}” is empty.`;
    if (!await ctx.ui.confirm("Delete column?", detail)) return;
    try {
      store.mutate((document) => deleteColumn(document, columnIndex));
      state.selectedCards.splice(columnIndex, 1);
      state.cardOffsets.splice(columnIndex, 1);
      state.selectedColumn = Math.min(columnIndex, store.document.columns.length - 1);
      clearStatus(state);
    } catch (error) {
      mutationError(ctx, state, error);
    }
  }
}

function layoutHeightLabel(settings: KanbanLayoutSettings): string {
  return settings.boardHeight === "auto" ? "Auto" : `${settings.boardHeight} rows`;
}

type LayoutSaver = (settings: KanbanLayoutSettings) => KanbanLayoutSettings;

function applyLayoutSettings(
  state: PanelState,
  settings: KanbanLayoutSettings,
  ctx: ExtensionCommandContext,
  message: string,
  saveLayout: LayoutSaver,
): void {
  const pendingLayout = normalizeKanbanLayout(settings);
  try {
    state.pendingLayout = saveLayout(pendingLayout);
    state.message = `${message} · applies next time /kanban opens`;
    state.messageKind = undefined;
    ctx.ui.notify(`${message}. Close and reopen /kanban to apply.`, "info");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    state.message = `Display settings were not saved: ${detail}`;
    state.messageKind = "error";
    ctx.ui.notify(state.message, "warning");
  }
}

export async function runDisplaySettings(
  state: PanelState,
  ctx: ExtensionCommandContext,
  saveLayout: LayoutSaver = saveKanbanLayout,
): Promise<void> {
  for (;;) {
    const heightOption = `Board height · ${layoutHeightLabel(state.pendingLayout)}`;
    const cardOption = `Card rows · ${state.pendingLayout.cardRows}`;
    const resetOption = "Reset display defaults";
    const backOption = "Back to board";
    const choice = await ctx.ui.select("Kanban display settings · next open", [
      heightOption,
      cardOption,
      resetOption,
      backOption,
    ]);
    if (!choice || choice === backOption) return;

    if (choice === heightOption) {
      const value = await ctx.ui.input(
        `Board height · ${layoutHeightLabel(state.pendingLayout)}`,
        `Type auto or ${MIN_BOARD_HEIGHT}-${MAX_BOARD_HEIGHT} rows`,
      );
      if (value === undefined) continue;
      const trimmed = value.trim().toLocaleLowerCase();
      const parsed = Number(trimmed);
      const boardHeight = trimmed === "auto"
        ? "auto"
        : Number.isInteger(parsed) && parsed >= MIN_BOARD_HEIGHT && parsed <= MAX_BOARD_HEIGHT
          ? parsed
          : undefined;
      if (boardHeight === undefined) {
        ctx.ui.notify(
          `Board height must be auto or an integer from ${MIN_BOARD_HEIGHT} to ${MAX_BOARD_HEIGHT}`,
          "warning",
        );
        continue;
      }
      applyLayoutSettings(
        state,
        { ...state.pendingLayout, boardHeight },
        ctx,
        `Kanban board height saved: ${boardHeight === "auto" ? "Auto" : `${boardHeight} rows`}`,
        saveLayout,
      );
      continue;
    }

    if (choice === cardOption) {
      const value = await ctx.ui.input(
        `Card rows · ${state.pendingLayout.cardRows}`,
        `${MIN_CARD_ROWS}-${MAX_CARD_ROWS} rows including the title`,
      );
      if (value === undefined) continue;
      const parsed = Number(value.trim());
      if (!Number.isInteger(parsed) || parsed < MIN_CARD_ROWS || parsed > MAX_CARD_ROWS) {
        ctx.ui.notify(
          `Card rows must be an integer from ${MIN_CARD_ROWS} to ${MAX_CARD_ROWS}`,
          "warning",
        );
        continue;
      }
      applyLayoutSettings(
        state,
        { ...state.pendingLayout, cardRows: parsed },
        ctx,
        `Kanban card rows saved: ${parsed}`,
        saveLayout,
      );
      continue;
    }

    if (choice === resetOption) {
      applyLayoutSettings(
        state,
        defaultKanbanLayout(),
        ctx,
        "Kanban display defaults saved",
        saveLayout,
      );
    }
  }
}

export async function runPanel(
  store: BoardStore,
  state: PanelState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  for (;;) {
    const action = await ctx.ui.custom<PanelAction>(
      (tui, theme, _keybindings, done) => {
        const panel = new KanbanPanel(store, state, tui, theme, done);
        return {
          render: (width: number) => panel.render(width),
          invalidate: () => panel.invalidate(),
          handleInput: (data: string) => {
            panel.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          // Keep the adaptive panel flush with Pi's editor/status area. A top anchor
          // exposes old transcript rows below the panel whenever its content shrinks.
          anchor: "bottom-center",
          margin: { bottom: KANBAN_BOTTOM_RESERVED_ROWS },
          width: "100%",
        },
      },
    );

    if (action.type === "close") return;

    if (action.type === "settings") {
      await runDisplaySettings(state, ctx);
      continue;
    }

    if (action.type === "search") {
      const query = await ctx.ui.input("Search cards", action.query || "Title or card text");
      if (query !== undefined) {
        state.searchQuery = query.trim();
        state.selectedCards = store.document.columns.map(() => 0);
        state.cardOffsets = store.document.columns.map(() => 0);
        clearStatus(state);
      }
      continue;
    }

    if (action.type === "column") {
      await runColumnMenu(store, state, ctx, action.columnIndex);
      continue;
    }

    if (action.type === "time") {
      const found = findCard(store.document, action.cardId);
      if (!found) continue;
      const current = readCardMetadata(found.card).time;
      const shortcuts = cardTimeShortcuts();
      const choice = await ctx.ui.select(
        `Set time · ${found.card.title}`,
        shortcuts.map((shortcut) => shortcut.label),
      );
      if (!choice) continue;
      const shortcut = shortcuts.find((item) => item.label === choice);
      const value = shortcut?.value ?? await ctx.ui.input(
        "Custom card time",
        current ? `Current: ${current}` : "YYYY-MM-DD HH:mm or free text",
      );
      if (value?.trim()) {
        try {
          store.mutate((document) => setCardTime(document, action.cardId, value));
          clearStatus(state);
        } catch (error) {
          mutationError(ctx, state, error);
        }
      }
      continue;
    }

    if (action.type === "label") {
      const found = findCard(store.document, action.cardId);
      if (!found) continue;
      const value = await ctx.ui.input("Add label", "Label name, for example urgent or needs review");
      if (value?.trim()) {
        try {
          store.mutate((document) => addCardLabel(document, action.cardId, value));
          clearStatus(state);
        } catch (error) {
          mutationError(ctx, state, error);
        }
      }
      continue;
    }

    if (action.type === "add") {
      const column = store.document.columns[action.columnIndex];
      if (!column) continue;
      const text = await ctx.ui.editor(`Add card · ${column.title}`, "");
      if (text?.trim()) {
        try {
          let newCardId: string | undefined;
          store.mutate((document) => {
            newCardId = addCard(document, action.columnIndex, text).id;
          });
          state.selectedColumn = action.columnIndex;
          const visible = store.document.columns[action.columnIndex];
          const index = visible && newCardId
            ? visible.blocks.filter((block) => block.kind === "card").findIndex((card) => card.id === newCardId)
            : -1;
          state.selectedCards[action.columnIndex] = Math.max(0, index);
          clearStatus(state);
        } catch (error) {
          mutationError(ctx, state, error);
        }
      }
      continue;
    }

    if (action.type === "edit") {
      const found = findCard(store.document, action.cardId);
      if (!found) continue;
      const text = await ctx.ui.editor(`Edit card · ${found.column.title}`, cardToEditableText(found.card));
      if (text !== undefined && text.trim()) {
        try {
          store.mutate((document) => {
            updateCardFromEditableText(document, action.cardId, text);
          });
          clearStatus(state);
        } catch (error) {
          mutationError(ctx, state, error);
        }
      }
      continue;
    }

    if (action.type === "delete") {
      const confirmed = await ctx.ui.confirm("Delete card?", action.title || "Untitled card");
      if (confirmed) {
        try {
          store.mutate((document) => {
            deleteCard(document, action.cardId);
          });
          clearStatus(state);
          state.view = "board";
        } catch (error) {
          mutationError(ctx, state, error);
        }
      }
    }
  }
}

export default function piKanban(pi: ExtensionAPI): void {
  registerKanbanTool(pi);

  pi.registerCommand("kanban", {
    description: "Open a project or global keyboard-first Kanban board",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/kanban requires Pi's interactive TUI mode", "error");
        return;
      }

      try {
        const trimmedArgs = args.trim();
        let boardPath: string;
        const explicitScope = /^(project|global)$/i.test(trimmedArgs)
          ? trimmedArgs.toLocaleLowerCase() as BoardScope
          : undefined;
        if (explicitScope || !trimmedArgs) {
          const location = await chooseBoardLocation(ctx, explicitScope);
          if (!location) return;
          boardPath = location.path;
          if (location.created) {
            const label = location.scope === "project"
              ? "Created this project’s .pi/kanban.md"
              : "Created the global Kanban board in Pi’s user data directory";
            ctx.ui.notify(label, "info");
          }
        } else {
          const importMatch = trimmedArgs.match(/^import(?:\s+(.*))?$/i);
          if (!importMatch) {
            ctx.ui.notify(
              "Usage: /kanban [project|global]  or  /kanban import <legacy-board.md>",
              "warning",
            );
            return;
          }
          const rawSource = importMatch[1]?.trim()
            || await ctx.ui.input("Import Markdown board", "Absolute or project-relative source path");
          if (!rawSource?.trim()) return;
          const sourcePath = resolveImportPath(unquote(rawSource), ctx.cwd);
          if (!usableFile(sourcePath)) {
            ctx.ui.notify(`Import file not found: ${sourcePath}`, "error");
            return;
          }

          const target = await chooseImportLocation(ctx);
          if (!target) return;
          const targetPath = target.path;
          if (existsSync(targetPath) && sourcePath !== targetPath) {
            const isProject = target.scope === "project";
            const confirmed = await ctx.ui.confirm(
              isProject ? "Replace project board?" : "Replace global board?",
              isProject
                ? "The current .pi/kanban.md will be replaced. The imported source will not be changed."
                : "The global Kanban board will be replaced. The imported source will not be changed.",
            );
            if (!confirmed) return;
          }
          boardPath = importScopedBoard(target.scope, ctx.cwd, sourcePath).path;
          const label = target.scope === "project"
            ? "Imported into this project’s .pi/kanban.md"
            : "Imported into the global Kanban board";
          ctx.ui.notify(label, "info");
        }

        const store = new BoardStore(boardPath);
        await runPanel(store, createPanelState(loadKanbanLayout()), ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
