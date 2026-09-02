import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cardsIn, type KanbanCard, type KanbanColumn, type KanbanDocument } from "./board-model.js";
import { BoardStore } from "./board-store.js";
import {
  addCard,
  addCardLabel,
  addColumn,
  deleteCard,
  deleteColumn,
  moveCard,
  moveColumn,
  renameColumn,
  setCardChecked,
  setCardTime,
  updateCardFromEditableText,
  readCardMetadata,
} from "./markdown-board.js";
import {
  ensureScopedBoard,
  findExistingBoard,
  findScopedBoard,
  type BoardScope,
  type ScopedBoardLocation,
} from "./project-board.js";

const KanbanToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("add_card"),
    Type.Literal("edit_card"),
    Type.Literal("move_card"),
    Type.Literal("set_done"),
    Type.Literal("set_time"),
    Type.Literal("add_label"),
    Type.Literal("delete_card"),
    Type.Literal("add_column"),
    Type.Literal("rename_column"),
    Type.Literal("move_column"),
    Type.Literal("delete_column"),
  ], { description: "Board operation to perform" }),
  card: Type.Optional(Type.String({ description: "Exact current card title" })),
  column: Type.Optional(Type.String({
    description: "Column title; restricts list output, targets add_card, scopes card lookup, or selects a column to change",
  })),
  targetColumn: Type.Optional(Type.String({ description: "Destination column title for move_card" })),
  text: Type.Optional(Type.String({ description: "Card title on line 1, followed by optional Markdown body lines" })),
  title: Type.Optional(Type.String({ description: "New column title" })),
  done: Type.Optional(Type.Boolean({ description: "Desired completed state for set_done" })),
  time: Type.Optional(Type.String({ description: "Single-line time value for set_time" })),
  label: Type.Optional(Type.String({ description: "Custom label value for add_label" })),
  direction: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")], {
    description: "Direction for move_column",
  })),
  after: Type.Optional(Type.String({ description: "Existing column after which to insert a new column" })),
  query: Type.Optional(Type.String({ description: "Case-insensitive filter across full card text for list" })),
  includeDetails: Type.Optional(Type.Boolean({
    description: "For list, include each visible card's complete body after its time and labels",
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum cards returned by list (default 100)" })),
  deleteCards: Type.Optional(Type.Boolean({
    description: "Must be true to delete a non-empty column and all cards in it",
  })),
  scope: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("project"),
    Type.Literal("global"),
  ], {
    description: "Board scope. auto uses project first, then global; specify project/global to create that scope.",
  })),
});

export type KanbanToolParams = {
  action:
    | "list"
    | "add_card"
    | "edit_card"
    | "move_card"
    | "set_done"
    | "set_time"
    | "add_label"
    | "delete_card"
    | "add_column"
    | "rename_column"
    | "move_column"
    | "delete_column";
  card?: string;
  column?: string;
  targetColumn?: string;
  text?: string;
  title?: string;
  done?: boolean;
  time?: string;
  label?: string;
  direction?: "left" | "right";
  after?: string;
  query?: string;
  includeDetails?: boolean;
  limit?: number;
  deleteCards?: boolean;
  scope?: "auto" | BoardScope;
};

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`kanban_board: “${name}” is required for this action`);
  return result;
}

function matchingColumns(document: KanbanDocument, title: string): Array<{
  column: KanbanColumn;
  index: number;
}> {
  const expected = title.trim().toLocaleLowerCase();
  return document.columns.flatMap((column, index) =>
    column.title.toLocaleLowerCase() === expected ? [{ column, index }] : [],
  );
}

function requireColumn(document: KanbanDocument, title: string): {
  column: KanbanColumn;
  index: number;
} {
  const matches = matchingColumns(document, title);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Column title is ambiguous: ${title}`);
  const available = document.columns.map((column) => column.title).join(", ");
  throw new Error(`Column not found: ${title}. Available columns: ${available}`);
}

function requireCard(
  document: KanbanDocument,
  title: string,
  columnTitle?: string,
): { card: KanbanCard; column: KanbanColumn; columnIndex: number } {
  const expected = title.trim().toLocaleLowerCase();
  const allowedColumn = columnTitle ? requireColumn(document, columnTitle) : undefined;
  const matches: Array<{ card: KanbanCard; column: KanbanColumn; columnIndex: number }> = [];

  for (let columnIndex = 0; columnIndex < document.columns.length; columnIndex += 1) {
    const column = document.columns[columnIndex];
    if (!column || (allowedColumn && columnIndex !== allowedColumn.index)) continue;
    for (const card of cardsIn(column)) {
      if (card.title.toLocaleLowerCase() === expected) matches.push({ card, column, columnIndex });
    }
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Card title is ambiguous: ${title}. Supply its current “column”.`);
  }
  throw new Error(`Card not found: ${title}${columnTitle ? ` in ${columnTitle}` : ""}`);
}

function formattedLabel(label: string): string {
  return /\s/.test(label) ? `#{${clean(label)}}` : `#${clean(label)}`;
}

function safeBodyLine(line: string): string {
  return line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function summarizeBoard(
  document: KanbanDocument,
  query = "",
  limit = 100,
  scope: BoardScope = "project",
  columnTitle?: string,
  includeDetails = false,
): string {
  const normalized = query.trim().toLocaleLowerCase();
  const lines = [`Kanban · ${scope}`];
  const columns = columnTitle
    ? [requireColumn(document, columnTitle).column]
    : document.columns;
  let shown = 0;
  let matched = 0;

  for (const column of columns) {
    const cards = cardsIn(column);
    const visible = normalized
      ? cards.filter((card) => card.raw.toLocaleLowerCase().includes(normalized))
      : cards;
    matched += visible.length;
    lines.push(`\n${clean(column.title)} (${visible.length}${normalized ? `/${cards.length}` : ""})`);
    for (const card of visible) {
      if (shown >= limit) continue;
      const metadata = readCardMetadata(card);
      const time = metadata.time ? ` · @{${clean(metadata.time)}}` : "";
      const labels = metadata.labels.length > 0
        ? ` · ${metadata.labels.map(formattedLabel).join(" ")}`
        : "";
      lines.push(`- [${card.checked ? "x" : " "}] ${clean(card.title) || "(untitled)"}${time}${labels}`);
      if (includeDetails && metadata.bodyLines.length > 0) {
        lines.push("  Body:");
        for (const bodyLine of metadata.bodyLines) {
          lines.push(`    ${safeBodyLine(bodyLine)}`);
        }
      }
      shown += 1;
    }
  }

  if (matched > shown) lines.push(`\n… ${matched - shown} more matching card(s); narrow the query or raise limit.`);
  return lines.join("\n");
}

export function resolveKanbanBoardLocation(
  params: Pick<KanbanToolParams, "action" | "scope">,
  cwd: string,
  agentDir?: string,
): ScopedBoardLocation | undefined {
  const requestedScope = params.scope ?? "auto";
  if (requestedScope === "auto") {
    return findExistingBoard(cwd, agentDir);
  }
  if (params.action === "list") {
    return findScopedBoard(requestedScope, cwd, agentDir);
  }
  return ensureScopedBoard(requestedScope, cwd, agentDir);
}

export function runKanbanAction(
  store: BoardStore,
  params: KanbanToolParams,
  scope: BoardScope = "project",
): string {
  const document = store.document;

  switch (params.action) {
    case "list":
      return summarizeBoard(
        document,
        params.query,
        params.limit ?? 100,
        scope,
        params.column,
        params.includeDetails ?? false,
      );

    case "add_card": {
      const columnTitle = required(params.column, "column");
      const text = required(params.text, "text");
      const target = requireColumn(document, columnTitle);
      let title = "";
      store.mutate((next) => {
        title = addCard(next, target.index, text).title;
      });
      return `Added “${clean(title)}” to “${clean(target.column.title)}”.`;
    }

    case "edit_card": {
      const cardTitle = required(params.card, "card");
      const text = required(params.text, "text");
      const found = requireCard(document, cardTitle, params.column);
      store.mutate((next) => updateCardFromEditableText(next, found.card.id, text));
      return `Updated “${clean(found.card.title)}” in “${clean(found.column.title)}”.`;
    }

    case "move_card": {
      const cardTitle = required(params.card, "card");
      const targetTitle = required(params.targetColumn, "targetColumn");
      const found = requireCard(document, cardTitle, params.column);
      const target = requireColumn(document, targetTitle);
      if (found.columnIndex === target.index) return `“${clean(found.card.title)}” is already in “${clean(target.column.title)}”.`;
      store.mutate((next) => moveCard(next, found.card.id, target.index));
      return `Moved “${clean(found.card.title)}” to “${clean(target.column.title)}”.`;
    }

    case "set_done": {
      const cardTitle = required(params.card, "card");
      if (params.done === undefined) throw new Error("kanban_board: “done” is required for set_done");
      const found = requireCard(document, cardTitle, params.column);
      store.mutate((next) => setCardChecked(next, found.card.id, params.done!));
      return `Marked “${clean(found.card.title)}” ${params.done ? "done" : "open"}.`;
    }

    case "set_time": {
      const cardTitle = required(params.card, "card");
      const time = required(params.time, "time");
      const found = requireCard(document, cardTitle, params.column);
      store.mutate((next) => setCardTime(next, found.card.id, time));
      return `Set time on “${clean(found.card.title)}” to “${clean(time)}”.`;
    }

    case "add_label": {
      const cardTitle = required(params.card, "card");
      const label = required(params.label, "label");
      const found = requireCard(document, cardTitle, params.column);
      store.mutate((next) => addCardLabel(next, found.card.id, label));
      return `Added label “${clean(label)}” to “${clean(found.card.title)}”.`;
    }

    case "delete_card": {
      const cardTitle = required(params.card, "card");
      const found = requireCard(document, cardTitle, params.column);
      store.mutate((next) => deleteCard(next, found.card.id));
      return `Deleted card “${clean(found.card.title)}” from “${clean(found.column.title)}”.`;
    }

    case "add_column": {
      const title = required(params.title, "title");
      const afterIndex = params.after ? requireColumn(document, params.after).index : document.columns.length - 1;
      store.mutate((next) => addColumn(next, title, afterIndex));
      return `Added column “${clean(title)}”.`;
    }

    case "rename_column": {
      const columnTitle = required(params.column, "column");
      const title = required(params.title, "title");
      const found = requireColumn(document, columnTitle);
      store.mutate((next) => renameColumn(next, found.index, title));
      return `Renamed column “${clean(columnTitle)}” to “${clean(title)}”.`;
    }

    case "move_column": {
      const columnTitle = required(params.column, "column");
      if (!params.direction) throw new Error("kanban_board: “direction” is required for move_column");
      const found = requireColumn(document, columnTitle);
      const target = found.index + (params.direction === "left" ? -1 : 1);
      if (target < 0 || target >= document.columns.length) {
        return `Column “${clean(found.column.title)}” is already at the ${params.direction} edge.`;
      }
      store.mutate((next) => moveColumn(next, found.index, target));
      return `Moved column “${clean(found.column.title)}” ${params.direction}.`;
    }

    case "delete_column": {
      const columnTitle = required(params.column, "column");
      const found = requireColumn(document, columnTitle);
      const count = cardsIn(found.column).length;
      if (document.columns.length <= 1) throw new Error("The board must keep at least one column");
      if (count > 0 && params.deleteCards !== true) {
        throw new Error(`Column “${columnTitle}” contains ${count} card(s); set deleteCards=true only if the user explicitly requested their deletion.`);
      }
      store.mutate((next) => deleteColumn(next, found.index));
      return `Deleted column “${clean(found.column.title)}”${count ? ` and ${count} card(s)` : ""}.`;
    }
  }
}

export function registerKanbanTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kanban_board",
    label: "Kanban Board",
    description: "Read or update a Pi Kanban board. Auto scope reads the current project's board first, then falls back to global. Read-only list never creates a board; an explicit project/global write may create its target. Use exact card and column titles.",
    promptSnippet: "Read and update the active project or global Kanban board.",
    promptGuidelines: [
      "Use kanban_board only when the user asks about or wants to change their project board.",
      "List the board first when a card or column title is uncertain or ambiguous.",
      "If no board exists, ask whether the user wants project or global scope before creating one.",
      "Only delete cards or columns when the user explicitly requests that destructive change.",
    ],
    parameters: KanbanToolParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requestedScope = params.scope ?? "auto";
      const location = resolveKanbanBoardLocation(params as KanbanToolParams, ctx.cwd);
      if (!location) {
        const target = requestedScope === "auto" ? "project or global" : requestedScope;
        throw new Error(`No ${target} Kanban board exists. Read-only list does not create boards; ask the user before a write creates one.`);
      }
      const store = new BoardStore(location.path);
      const text = runKanbanAction(store, params as KanbanToolParams, location.scope);
      return {
        content: [{ type: "text", text }],
        details: {
          action: params.action,
          path: location.path,
          scope: location.scope,
          created: location.created,
        },
      };
    },
  });
}
