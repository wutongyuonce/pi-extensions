import { basename, dirname } from "node:path";
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  parseKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { cardCount, cardsIn, type KanbanCard, type KanbanColumn } from "./board-model.js";
import { BoardConflictError, type BoardStore } from "./board-store.js";
import {
  cardToClipboardText,
  cardToEditableText,
  moveCard,
  readCardMetadata,
  reorderCard,
  toggleCard,
} from "./markdown-board.js";
import {
  MIN_BOARD_HEIGHT,
  normalizeKanbanLayout,
  type KanbanLayoutSettings,
} from "./kanban-settings.js";

const MIN_COLUMN_WIDTH = 25;
const MAX_VISIBLE_COLUMNS = 5;
export const KANBAN_BOTTOM_RESERVED_ROWS = 4;
const BOARD_BASE_ROWS = 4;
const DETAIL_BASE_ROWS = 3;
const MIN_BODY_ROWS = 3;
const MAX_BODY_ROWS = 24;
const MAX_PANEL_ROWS = 34;
const MAX_FOOTER_ROWS = 7;
const FOOTER_COLUMN_GAP = 4;
const FOOTER_ACTION_SEPARATOR = "  │  ";

export type PanelAction =
  | { type: "close" }
  | { type: "add"; columnIndex: number }
  | { type: "edit"; cardId: string }
  | { type: "delete"; cardId: string; title: string }
  | { type: "time"; cardId: string }
  | { type: "label"; cardId: string }
  | { type: "column"; columnIndex: number }
  | { type: "search"; query: string }
  | { type: "settings" };

export type PanelView = "board" | "detail" | "help";

export interface PanelState {
  view: PanelView;
  helpReturnView: Exclude<PanelView, "help">;
  detailScroll: number;
  selectedColumn: number;
  selectedCards: number[];
  cardOffsets: number[];
  columnOffset: number;
  searchQuery: string;
  /** Layout used by the currently open panel. It stays unchanged until the panel is reopened. */
  layout: KanbanLayoutSettings;
  /** Persisted layout that will be used the next time /kanban opens. */
  pendingLayout: KanbanLayoutSettings;
  message?: string;
  messageKind?: "warning" | "error";
}

export function createPanelState(layout?: KanbanLayoutSettings): PanelState {
  const activeLayout = normalizeKanbanLayout(layout);
  return {
    view: "board",
    helpReturnView: "board",
    detailScroll: 0,
    selectedColumn: 0,
    selectedCards: [],
    cardOffsets: [],
    columnOffset: 0,
    searchQuery: "",
    layout: { ...activeLayout },
    pendingLayout: { ...activeLayout },
  };
}

function safeText(value: string): string {
  return value
    .replace(/\x1b/g, "␛")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\t/g, "    ");
}

function padAnsi(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(1, width));
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function ellipsize(value: string, width: number, force = false): string {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return "";
  if (!force && visibleWidth(value) <= safeWidth) return value;
  if (safeWidth === 1) return "…";
  return `${truncateToWidth(value, safeWidth - 1)}…`;
}

function parsedKey(data: string): string | undefined {
  return parseKey(data) ?? (data.length === 1 ? data : undefined);
}

function isShiftKey(
  data: string,
  key: "left" | "right" | "up" | "down" | "g" | "j" | "k",
): boolean {
  return matchesKey(data, Key.shift(key)) || data === key.toUpperCase();
}

export class KanbanPanel {
  private lastBodyRows = MIN_BODY_ROWS;
  private lastSelectedColumnWidth = MIN_COLUMN_WIDTH;
  private copyNotice?: { text: string; kind: "success" | "error" };
  private readonly cardDisplayLineCache = new WeakMap<
    KanbanCard,
    {
      signature: string;
      lines: Array<{ text: string; kind: "title" | "body" }>;
    }
  >();

  constructor(
    private readonly store: BoardStore,
    private readonly state: PanelState,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (action: PanelAction) => void,
    private readonly copyText: (text: string) => Promise<void> = copyToClipboard,
    private readonly wrapCardText: typeof wrapTextWithAnsi = wrapTextWithAnsi,
  ) {
    this.clampState();
  }

  invalidate(): void {
    // Rendering is derived from live state and the current Theme object.
  }

  handleInput(data: string): void {
    if (this.state.view === "help") {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.backspace) ||
        parsedKey(data) === "?"
      ) {
        this.state.view = this.state.helpReturnView;
      } else if (parsedKey(data) === "q") {
        this.done({ type: "close" });
      }
      return;
    }

    if (this.state.view === "detail") {
      this.handleDetailInput(data);
      return;
    }

    this.handleBoardInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.state.view === "help") return this.renderHelp(safeWidth);
    if (this.state.view === "detail") return this.renderDetail(safeWidth);
    return this.renderBoard(safeWidth);
  }

  private handleBoardInput(data: string): void {
    const key = parsedKey(data);

    if (matchesKey(data, Key.escape)) {
      if (this.state.searchQuery) {
        this.state.searchQuery = "";
        this.clearStatus();
        this.resetVisibleSelections();
      } else {
        this.done({ type: "close" });
      }
      return;
    }
    if (key === "q") {
      this.done({ type: "close" });
      return;
    }
    if (key === "?") {
      this.state.helpReturnView = "board";
      this.state.view = "help";
      return;
    }
    if (key === "/") {
      this.done({ type: "search", query: this.state.searchQuery });
      return;
    }
    if (key === "s") {
      this.done({ type: "settings" });
      return;
    }

    if (/^[1-9]$/.test(key ?? "")) {
      const target = Number(key) - 1;
      if (target < this.store.document.columns.length) this.selectColumn(target);
      return;
    }

    if (isShiftKey(data, "left") || key === "[") {
      this.moveSelectedAcross(-1);
      return;
    }
    if (isShiftKey(data, "right") || key === "]") {
      this.moveSelectedAcross(1);
      return;
    }
    if (isShiftKey(data, "up") || isShiftKey(data, "k")) {
      this.reorderSelected(-1);
      return;
    }
    if (isShiftKey(data, "down") || isShiftKey(data, "j")) {
      this.reorderSelected(1);
      return;
    }

    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.shift("tab")) ||
      key === "h"
    ) {
      this.selectColumn(this.state.selectedColumn - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab) || key === "l") {
      this.selectColumn(this.state.selectedColumn + 1);
      return;
    }
    if (matchesKey(data, Key.up) || key === "k") {
      this.selectCardBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || key === "j") {
      this.selectCardBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.selectCardBy(-this.cardPageSize());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.selectCardBy(this.cardPageSize());
      return;
    }
    if (matchesKey(data, Key.home) || key === "g") {
      this.setSelectedCard(0);
      return;
    }
    if (matchesKey(data, Key.end) || isShiftKey(data, "g")) {
      this.setSelectedCard(Number.MAX_SAFE_INTEGER);
      return;
    }

    if (matchesKey(data, Key.space)) {
      this.toggleSelected();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.currentCard()) {
        this.state.detailScroll = 0;
        this.copyNotice = undefined;
        this.state.view = "detail";
      }
      return;
    }
    if (key === "y") {
      this.copyCurrentCard();
      return;
    }
    if (key === "a") {
      this.done({ type: "add", columnIndex: this.state.selectedColumn });
      return;
    }
    if (key === "c") {
      this.done({ type: "column", columnIndex: this.state.selectedColumn });
      return;
    }
    if (key === "e") {
      const card = this.currentCard();
      if (card) this.done({ type: "edit", cardId: card.id });
      return;
    }
    if (key === "d") {
      const card = this.currentCard();
      if (card) this.done({ type: "delete", cardId: card.id, title: card.title });
      return;
    }
    if (key === "@") {
      const card = this.currentCard();
      if (card) this.done({ type: "time", cardId: card.id });
      return;
    }
    if (key === "#") {
      const card = this.currentCard();
      if (card) this.done({ type: "label", cardId: card.id });
      return;
    }
    if (key === "r") this.reload();
  }

  private handleDetailInput(data: string): void {
    const key = parsedKey(data);
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.backspace) ||
      matchesKey(data, Key.enter)
    ) {
      this.state.view = "board";
      return;
    }
    if (key === "q") {
      this.done({ type: "close" });
      return;
    }
    if (key === "?") {
      this.state.helpReturnView = "detail";
      this.state.view = "help";
      return;
    }
    if (matchesKey(data, Key.up) || key === "k") {
      this.state.detailScroll = Math.max(0, this.state.detailScroll - 1);
      return;
    }
    if (matchesKey(data, Key.down) || key === "j") {
      this.state.detailScroll += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.state.detailScroll = Math.max(0, this.state.detailScroll - this.bodyHeight());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.state.detailScroll += this.bodyHeight();
      return;
    }
    if (matchesKey(data, Key.home) || key === "g") {
      this.state.detailScroll = 0;
      return;
    }
    if (key === "e") {
      const card = this.currentCard();
      if (card) this.done({ type: "edit", cardId: card.id });
      return;
    }
    if (key === "d") {
      const card = this.currentCard();
      if (card) this.done({ type: "delete", cardId: card.id, title: card.title });
      return;
    }
    if (key === "y") {
      this.copyCurrentCard();
      return;
    }
    if (key === "@") {
      const card = this.currentCard();
      if (card) this.done({ type: "time", cardId: card.id });
      return;
    }
    if (key === "#") {
      const card = this.currentCard();
      if (card) this.done({ type: "label", cardId: card.id });
      return;
    }
    if (matchesKey(data, Key.space)) this.toggleSelected();
  }

  private renderBoard(width: number): string[] {
    this.clampState();
    const capacity = this.panelRowCapacity();
    if (capacity < MIN_BOARD_HEIGHT) return this.renderCompactBoard(width, capacity);
    const lines: string[] = [];
    const document = this.store.document;
    const window = this.visibleColumnWindow(width);
    const widths = this.columnWidths(width, window.length);
    const selectedWindowIndex = window.indexOf(this.state.selectedColumn);
    this.lastSelectedColumnWidth = widths[selectedWindowIndex] ?? MIN_COLUMN_WIDTH;
    const footerLines = this.boardFooterLines(width);
    const bodyRows = this.boardBodyHeight(
      window,
      widths,
      BOARD_BASE_ROWS + footerLines.length,
    );
    this.lastBodyRows = bodyRows;
    const totalCards = cardCount(document);
    const visibleTotal = document.columns.reduce(
      (count, column) => count + this.visibleCards(column).length,
      0,
    );
    const filename = safeText(`${basename(dirname(this.store.path))}/${basename(this.store.path)}`);
    const heading = `${this.theme.fg("accent", this.theme.bold("▣ PI KANBAN"))}  ${this.theme.fg("text", filename)}  ${this.theme.fg("dim", `${document.columns.length} columns · ${totalCards} cards`)}`;
    lines.push(truncateToWidth(heading, width));

    const selectedColumn = document.columns[this.state.selectedColumn];
    const selectedCards = selectedColumn ? this.visibleCards(selectedColumn) : [];
    const selectedIndex = this.state.selectedCards[this.state.selectedColumn] ?? 0;
    const position = selectedCards.length > 0 ? `${Math.min(selectedIndex + 1, selectedCards.length)}/${selectedCards.length}` : "empty";
    let context = `${this.state.selectedColumn + 1}/${document.columns.length} ${safeText(selectedColumn?.title ?? "")} · ${position}`;
    if (this.state.searchQuery) {
      context += ` · /${safeText(this.state.searchQuery)}/ · ${visibleTotal} matches`;
    }
    if (this.state.message) context += ` · ${safeText(this.state.message)}`;
    if (this.copyNotice) context += ` · ${safeText(this.copyNotice.text)}`;
    const contextColor =
      this.state.messageKind === "error"
        ? "error"
        : this.state.messageKind === "warning"
          ? "warning"
          : this.copyNotice
            ? this.copyNotice.kind === "success" ? "success" : "error"
            : "muted";
    lines.push(truncateToWidth(this.theme.fg(contextColor, context), width));

    lines.push(this.joinCells(window.map((columnIndex, index) => {
      const column = document.columns[columnIndex];
      return this.renderColumnHeader(column, widths[index] ?? 1, columnIndex);
    }), width));

    const columnRows = window.map((columnIndex, index) =>
      this.renderColumnCards(columnIndex, widths[index] ?? 1, bodyRows),
    );
    for (let row = 0; row < bodyRows; row += 1) {
      lines.push(this.joinCells(columnRows.map((column) => column[row] ?? ""), width));
    }

    lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
    lines.push(...footerLines.map((line) => truncateToWidth(this.theme.fg("dim", line), width)));
    return lines;
  }

  private renderCompactBoard(width: number, height: number): string[] {
    const document = this.store.document;
    const column = document.columns[this.state.selectedColumn];
    const cards = column ? this.visibleCards(column) : [];
    const selected = Math.min(this.state.selectedCards[this.state.selectedColumn] ?? 0, cards.length - 1);
    const card = cards[selected];
    const filename = safeText(`${basename(dirname(this.store.path))}/${basename(this.store.path)}`);
    const heading = `${this.theme.fg("accent", this.theme.bold("▣ PI KANBAN"))}  ${this.theme.fg("text", filename)}`;
    const copyNotice = this.copyNotice ? ` · ${safeText(this.copyNotice.text)}` : "";
    const context = `${this.state.selectedColumn + 1}/${document.columns.length} ${safeText(column?.title ?? "")} · ${cards.length > 0 ? `${selected + 1}/${cards.length}` : "empty"}${copyNotice}`;
    const lines = [truncateToWidth(heading, width)];
    const content = [
      truncateToWidth(this.theme.fg("muted", context), width),
      this.renderColumnHeader(column, width, this.state.selectedColumn),
      ...(card ? this.renderCardRows(card, width, true).slice(0, 1) : []),
    ];
    lines.push(...content.slice(0, Math.max(0, height - 2)));
    if (height > 1) {
      lines.push(truncateToWidth(
        this.theme.fg("dim", `? help${FOOTER_ACTION_SEPARATOR}q close`),
        width,
      ));
    }
    this.lastBodyRows = 1;
    this.lastSelectedColumnWidth = width;
    return lines;
  }

  private renderColumnHeader(column: KanbanColumn | undefined, width: number, index: number): string {
    if (!column) return " ".repeat(width);
    const all = cardsIn(column).length;
    const visible = this.visibleCards(column).length;
    const count = this.state.searchQuery ? `${visible}/${all}` : `${all}`;
    const label = ` ${index + 1} ${safeText(column.title)}  ${count} `;
    const styled = index === this.state.selectedColumn
      ? this.theme.fg("accent", this.theme.bold(label))
      : this.theme.fg("muted", label);
    return padAnsi(styled, width);
  }

  private renderColumnCards(columnIndex: number, width: number, height: number): string[] {
    const column = this.store.document.columns[columnIndex];
    if (!column) return Array.from({ length: height }, () => " ".repeat(width));
    const cards = this.visibleCards(column);
    if (cards.length === 0) {
      const empty = this.state.searchQuery ? "  no matches" : "  (empty)";
      return [padAnsi(this.theme.fg("dim", empty), width), ...Array.from({ length: height - 1 }, () => " ".repeat(width))];
    }

    const selection = Math.min(this.state.selectedCards[columnIndex] ?? 0, cards.length - 1);
    let offset = this.state.cardOffsets[columnIndex] ?? 0;
    if (selection < offset) offset = selection;
    offset = Math.max(0, Math.min(offset, cards.length - 1));
    while (
      offset < selection &&
      cards.slice(offset, selection + 1).reduce(
        (rows, card) => rows + this.cardRowCount(card, width),
        0,
      ) > height
    ) {
      offset += 1;
    }
    this.state.cardOffsets[columnIndex] = offset;

    const rows: string[] = [];
    for (let cardIndex = offset; cardIndex < cards.length && rows.length < height; cardIndex += 1) {
      const card = cards[cardIndex];
      if (!card) continue;
      const selected = columnIndex === this.state.selectedColumn && cardIndex === selection;
      rows.push(...this.renderCardRows(card, width, selected).slice(0, height - rows.length));
    }
    while (rows.length < height) rows.push(" ".repeat(width));
    return rows;
  }

  private cardDisplayLines(
    card: KanbanCard,
    width: number,
  ): Array<{ text: string; kind: "title" | "body" }> {
    const maximum = Math.max(1, this.state.layout.cardRows);
    const contentWidth = Math.max(1, width - 4);
    const signature = `${contentWidth}\u0000${maximum}\u0000${card.raw}\u0000${card.title}`;
    const cached = this.cardDisplayLineCache.get(card);
    if (cached?.signature === signature) return cached.lines;

    const title = safeText(card.title || "(untitled)");

    const metadata = readCardMetadata(card);
    const body = metadata.bodyLines.map((line) => line.trim()).filter(Boolean).map(safeText);
    const metadataParts: string[] = [];
    if (metadata.time) metadataParts.push(`@ ${safeText(metadata.time)}`);
    metadataParts.push(...metadata.labels.map((label) => `#${safeText(label)}`));

    const bodySources = [...body];
    const metadataText = metadataParts.join(" · ");
    if (metadataText) {
      if (bodySources[0]) bodySources[0] = `${bodySources[0]} · ${metadataText}`;
      else bodySources.push(metadataText);
    }

    const wrapped = [
      ...this.wrapCardText(title, contentWidth).map((text) => ({ text, kind: "title" as const })),
      ...bodySources.flatMap((source) =>
        this.wrapCardText(source, contentWidth).map((text) => ({ text, kind: "body" as const }))
      ),
    ];
    const visible = wrapped.slice(0, maximum);
    if (wrapped.length > maximum) {
      const last = visible.at(-1);
      if (last) last.text = ellipsize(last.text, contentWidth, true);
    }
    this.cardDisplayLineCache.set(card, { signature, lines: visible });
    return visible;
  }

  private cardRowCount(card: KanbanCard, width: number): number {
    return this.cardDisplayLines(card, width).length;
  }

  private renderCardRows(card: KanbanCard, width: number, selected: boolean): string[] {
    const marker = card.checked ? "✓" : "○";
    return this.cardDisplayLines(card, width).map((line, index) => {
      let styled = line.kind === "body"
        ? this.theme.fg("dim", line.text)
        : card.checked
          ? this.theme.fg("dim", this.theme.strikethrough(line.text))
          : this.theme.fg("text", line.text);
      if (selected && line.kind === "title") {
        styled = this.theme.fg("accent", this.theme.bold(line.text));
      }

      const prefix = index === 0
        ? `${selected ? this.theme.fg("accent", "›") : " "} ${
          card.checked ? this.theme.fg("success", marker) : this.theme.fg("dim", marker)
        } `
        : "    ";
      const row = padAnsi(`${prefix}${styled}`, width);
      return selected ? this.theme.bg("selectedBg", row) : row;
    });
  }

  private renderDetail(width: number): string[] {
    const card = this.currentCard();
    if (!card) {
      this.state.view = "board";
      return this.renderBoard(width);
    }
    const capacity = this.panelRowCapacity();
    if (capacity < MIN_BOARD_HEIGHT) return this.renderCompactDetail(card, width, capacity);
    const column = this.store.document.columns[this.state.selectedColumn];
    const lines: string[] = [];
    const notice = this.copyNotice
      ? ` · ${safeText(this.copyNotice.text)}`
      : "";
    lines.push(truncateToWidth(
      `${this.theme.fg("accent", this.theme.bold(card.checked ? "✓ CARD" : "○ CARD"))}  ${this.theme.fg("muted", safeText(column?.title ?? ""))}${
        this.copyNotice
          ? this.theme.fg(this.copyNotice.kind === "success" ? "success" : "error", notice)
          : ""
      }`,
      width,
    ));
    lines.push(this.theme.fg("borderMuted", "─".repeat(width)));

    const contentWidth = Math.max(1, width - 4);
    const contentLines: string[] = [];
    for (const sourceLine of cardToEditableText(card).split("\n")) {
      if (sourceLine.length === 0) {
        contentLines.push("");
      } else {
        contentLines.push(...wrapTextWithAnsi(safeText(sourceLine), contentWidth));
      }
    }
    const footerLines = this.detailFooterLines(width);
    const bodyRows = this.adaptiveBodyHeight(
      contentLines.length,
      DETAIL_BASE_ROWS + footerLines.length,
    );
    this.lastBodyRows = bodyRows;
    const maxScroll = Math.max(0, contentLines.length - bodyRows);
    this.state.detailScroll = Math.max(0, Math.min(this.state.detailScroll, maxScroll));
    for (let row = 0; row < bodyRows; row += 1) {
      const content = contentLines[this.state.detailScroll + row] ?? "";
      lines.push(truncateToWidth(`  ${content}`, width));
    }
    lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
    lines.push(...footerLines.map((line) => truncateToWidth(this.theme.fg("dim", line), width)));
    return lines;
  }

  private renderCompactDetail(card: KanbanCard, width: number, height: number): string[] {
    const heading = truncateToWidth(
      this.theme.fg("accent", this.theme.bold(card.checked ? "✓ CARD" : "○ CARD")),
      width,
    );
    const bodyRows = Math.max(0, height - 2);
    const body = cardToEditableText(card)
      .split("\n")
      .flatMap((line) => wrapTextWithAnsi(safeText(line), width))
      .slice(0, bodyRows)
      .map((line) => truncateToWidth(line, width));
    const lines = [heading, ...body];
    if (height > 1) lines.push(truncateToWidth(this.theme.fg("dim", "Enter/Esc return"), width));
    this.lastBodyRows = Math.max(1, body.length);
    return lines.slice(0, height);
  }

  private renderHelp(width: number): string[] {
    const help = [
      this.theme.fg("accent", this.theme.bold("PI KANBAN · Keyboard")),
      "",
      `${this.theme.fg("accent", "Navigate")}   ←→ or h/l or Tab · columns    ↑↓ or j/k · cards`,
      `${this.theme.fg("accent", "Jump")}       1–9 · column    Home/g · first    End/G · last    PgUp/PgDn · page`,
      `${this.theme.fg("accent", "Change")}     Space · toggle done    Shift+←→ or [ ] · move column`,
      `           Shift+↑↓ or K/J · reorder    a · add    e · edit    d · delete`,
      `${this.theme.fg("accent", "Metadata")}   @ · set time    # · add custom label`,
      `${this.theme.fg("accent", "Copy")}       Enter · open card details    y · copy the selected card`,
      `${this.theme.fg("accent", "Columns")}    c · add, rename, move, or delete the selected column`,
      `${this.theme.fg("accent", "Find")}       / · search all card text    Esc · clear active search`,
      `${this.theme.fg("accent", "Display")}    s · settings (applies next time /kanban opens)`,
      `${this.theme.fg("accent", "Open")}       Enter · card details    r · reload file    q/Esc · close`,
      "",
      this.theme.fg("dim", "No mouse handling. Every action is available from the keyboard."),
      this.theme.fg("dim", "Edits save immediately; an outside file change stops overwrites until reload."),
      "",
      this.theme.fg("muted", "Press ? / Enter / Esc to return"),
    ];
    const lines = help.flatMap((line) => line.length === 0 ? [""] : wrapTextWithAnsi(line, width));
    const maxRows = this.panelRowCapacity();
    const visible = lines.slice(0, maxRows);
    if (lines.length > maxRows && visible.length > 0) {
      visible[visible.length - 1] = this.theme.fg("muted", "… Press ? / Esc to return");
    }
    return visible.map((line) => truncateToWidth(line, width));
  }

  private panelRowCapacity(): number {
    const configured = this.state.view === "board" ? this.state.layout.boardHeight : "auto";
    const maximum = configured === "auto" ? MAX_PANEL_ROWS : configured;
    const available = Math.max(1, this.tui.terminal.rows - KANBAN_BOTTOM_RESERVED_ROWS);
    return Math.min(maximum, available);
  }

  private adaptiveBodyHeight(desiredRows: number, chromeRows: number): number {
    const capacity = Math.max(1, this.panelRowCapacity() - chromeRows);
    const minimum = Math.min(MIN_BODY_ROWS, capacity);
    return Math.max(minimum, Math.min(Math.max(1, desiredRows), MAX_BODY_ROWS, capacity));
  }

  private boardFooterLines(width: number): string[] {
    const separator = FOOTER_ACTION_SEPARATOR;
    const groups = [
      `Navigate: ←/→ switch columns${separator}↑/↓ select cards${separator}Enter open card details`,
      `Cards: Space toggle completion${separator}a add card${separator}e edit card${separator}d delete card`,
      `Move: Shift+←/→ move card between columns${separator}Shift+↑/↓ reorder card`,
      `Metadata: @ set card time${separator}# add custom label${separator}y copy selected card`,
      "Display: s settings (applies next time /kanban opens)",
      `Board: c manage column${separator}/ search cards${separator}? open keyboard help${separator}q close board`,
    ];
    const footerRows = this.twoColumnFooterLines(groups, width) ?? groups;
    return this.responsiveFooterLines(footerRows, width, BOARD_BASE_ROWS);
  }

  private twoColumnFooterLines(groups: string[], width: number): string[] | undefined {
    if (groups.length < 2 || width <= FOOTER_COLUMN_GAP + 1) return undefined;
    const rowCount = Math.ceil(groups.length / 2);
    const left = groups.slice(0, rowCount);
    const right = groups.slice(rowCount);
    if (right.length === 0) return undefined;

    const usableWidth = width - FOOTER_COLUMN_GAP;
    const leftWidth = Math.floor(usableWidth / 2);
    const rightWidth = usableWidth - leftWidth;
    const fits = left.every((line) => visibleWidth(line) <= leftWidth) &&
      right.every((line) => visibleWidth(line) <= rightWidth);
    if (!fits) return undefined;

    const gap = " ".repeat(FOOTER_COLUMN_GAP);
    return left.map((line, index) => {
      const rightLine = right[index];
      return rightLine === undefined ? line : `${padAnsi(line, leftWidth)}${gap}${rightLine}`;
    });
  }

  private detailFooterLines(width: number): string[] {
    const separator = FOOTER_ACTION_SEPARATOR;
    const groups = [
      `↑/↓ scroll card${separator}PageUp/PageDown scroll one page${separator}Enter or Esc return to board`,
      `y copy card${separator}Space toggle completion${separator}e edit card${separator}d delete card`,
      `@ set card time${separator}# add custom label${separator}? open keyboard help${separator}q close board`,
    ];
    return this.responsiveFooterLines(groups, width, DETAIL_BASE_ROWS);
  }

  private responsiveFooterLines(groups: string[], width: number, baseRows: number): string[] {
    const allLines = groups.flatMap((group) => wrapTextWithAnsi(group, width));
    const capacity = this.panelRowCapacity();
    const reservedBody = Math.min(MIN_BODY_ROWS, Math.max(1, capacity - baseRows - 1));
    const maximum = Math.max(
      1,
      Math.min(MAX_FOOTER_ROWS, capacity - baseRows - reservedBody),
    );
    const visible = allLines.slice(0, maximum);
    if (allLines.length > maximum && visible.length > 0) {
      const fallbacks = [
        `… ? open full keyboard help${FOOTER_ACTION_SEPARATOR}q close board`,
        "? open keyboard help",
        "? keyboard help",
        "? help",
        "?",
      ];
      visible[visible.length - 1] = fallbacks.find((text) => visibleWidth(text) <= width) ?? "";
    }
    return visible;
  }

  private boardBodyHeight(window: number[], widths: number[], chromeRows: number): number {
    if (this.state.layout.boardHeight !== "auto") {
      return Math.max(1, this.panelRowCapacity() - chromeRows);
    }
    const desired = window.reduce((largest, columnIndex, windowIndex) => {
      const column = this.store.document.columns[columnIndex];
      const width = widths[windowIndex] ?? MIN_COLUMN_WIDTH;
      const rows = column
        ? this.visibleCards(column).reduce(
          (total, card) => total + this.cardRowCount(card, width),
          0,
        )
        : 0;
      return Math.max(largest, rows);
    }, 0);
    return this.adaptiveBodyHeight(desired, chromeRows);
  }

  private visibleColumnWindow(width: number): number[] {
    const total = this.store.document.columns.length;
    if (total === 0) return [];
    const count = Math.max(
      1,
      Math.min(total, MAX_VISIBLE_COLUMNS, Math.floor((width + 1) / (MIN_COLUMN_WIDTH + 1))),
    );
    let offset = this.state.columnOffset;
    if (this.state.selectedColumn < offset) offset = this.state.selectedColumn;
    if (this.state.selectedColumn >= offset + count) offset = this.state.selectedColumn - count + 1;
    offset = Math.max(0, Math.min(offset, total - count));
    this.state.columnOffset = offset;
    return Array.from({ length: count }, (_, index) => offset + index);
  }

  private columnWidths(width: number, count: number): number[] {
    if (count <= 0) return [];
    const usable = Math.max(count, width - (count - 1));
    const base = Math.floor(usable / count);
    const remainder = usable % count;
    return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  private joinCells(cells: string[], width: number): string {
    const separator = this.theme.fg("borderMuted", "│");
    return truncateToWidth(cells.join(separator), width);
  }

  private visibleCards(column: KanbanColumn): KanbanCard[] {
    const cards = cardsIn(column);
    const query = this.state.searchQuery.trim().toLocaleLowerCase();
    if (!query) return cards;
    return cards.filter((card) => card.raw.toLocaleLowerCase().includes(query));
  }

  private currentCard(): KanbanCard | undefined {
    const column = this.store.document.columns[this.state.selectedColumn];
    if (!column) return undefined;
    const cards = this.visibleCards(column);
    const index = Math.min(this.state.selectedCards[this.state.selectedColumn] ?? 0, cards.length - 1);
    return cards[index];
  }

  private selectColumn(target: number): void {
    const total = this.store.document.columns.length;
    if (total === 0) return;
    this.state.selectedColumn = Math.max(0, Math.min(target, total - 1));
    this.clampState();
  }

  private selectCardBy(delta: number): void {
    const current = this.state.selectedCards[this.state.selectedColumn] ?? 0;
    this.setSelectedCard(current + delta);
  }

  private setSelectedCard(target: number): void {
    const column = this.store.document.columns[this.state.selectedColumn];
    const count = column ? this.visibleCards(column).length : 0;
    this.state.selectedCards[this.state.selectedColumn] = count === 0
      ? 0
      : Math.max(0, Math.min(target, count - 1));
  }

  private cardPageSize(): number {
    const column = this.store.document.columns[this.state.selectedColumn];
    const cards = column ? this.visibleCards(column) : [];
    if (cards.length === 0) return 1;
    const averageRows = cards.reduce(
      (total, card) => total + this.cardRowCount(card, this.lastSelectedColumnWidth),
      0,
    ) / cards.length;
    return Math.max(1, Math.floor(this.lastBodyRows / averageRows));
  }

  private copyCurrentCard(): void {
    const card = this.currentCard();
    if (!card) return;
    this.copyNotice = undefined;
    void this.copyText(cardToClipboardText(card)).then(() => {
      this.copyNotice = { text: "Copied card to clipboard", kind: "success" };
      this.tui.requestRender();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.copyNotice = { text: `Copy failed: ${message}`, kind: "error" };
      this.tui.requestRender();
    });
  }

  private toggleSelected(): void {
    const card = this.currentCard();
    if (!card) return;
    this.mutate((store) => {
      toggleCard(store.document, card.id);
    });
  }

  private moveSelectedAcross(delta: -1 | 1): void {
    const card = this.currentCard();
    const targetColumn = this.state.selectedColumn + delta;
    if (!card || targetColumn < 0 || targetColumn >= this.store.document.columns.length) return;
    const cardId = card.id;
    const moved = this.mutate((store) => {
      moveCard(store.document, cardId, targetColumn);
    });
    if (!moved) return;
    this.state.selectedColumn = targetColumn;
    const target = this.store.document.columns[targetColumn];
    const index = target ? this.visibleCards(target).findIndex((item) => item.id === cardId) : -1;
    this.state.selectedCards[targetColumn] = Math.max(0, index);
    this.clampState();
  }

  private reorderSelected(delta: -1 | 1): void {
    if (this.state.searchQuery) {
      this.state.message = "Clear search before reordering";
      this.state.messageKind = "warning";
      return;
    }
    const card = this.currentCard();
    if (!card) return;
    const before = this.state.selectedCards[this.state.selectedColumn] ?? 0;
    let changed = false;
    const saved = this.mutate((store) => {
      changed = reorderCard(store.document, card.id, delta);
    });
    if (saved && changed) this.state.selectedCards[this.state.selectedColumn] = before + delta;
  }

  private mutate(mutation: (store: BoardStore) => void): boolean {
    try {
      this.store.mutate(() => mutation(this.store));
      this.clearStatus();
      this.clampState();
      return true;
    } catch (error) {
      if (error instanceof BoardConflictError) {
        this.state.message = "Board changed on disk — press r to reload";
        this.state.messageKind = "warning";
      } else {
        this.state.message = error instanceof Error ? error.message : String(error);
        this.state.messageKind = "error";
      }
      return false;
    }
  }

  private reload(): void {
    try {
      this.store.reload();
      this.clearStatus();
      this.clampState();
    } catch (error) {
      this.state.message = error instanceof Error ? error.message : String(error);
      this.state.messageKind = "error";
    }
  }

  private clampState(): void {
    const columns = this.store.document.columns;
    this.state.selectedColumn = Math.max(0, Math.min(this.state.selectedColumn, Math.max(0, columns.length - 1)));
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const count = column ? this.visibleCards(column).length : 0;
      const current = this.state.selectedCards[index] ?? 0;
      this.state.selectedCards[index] = count === 0 ? 0 : Math.max(0, Math.min(current, count - 1));
      this.state.cardOffsets[index] = Math.max(0, this.state.cardOffsets[index] ?? 0);
    }
  }

  private resetVisibleSelections(): void {
    this.state.selectedCards = this.store.document.columns.map(() => 0);
    this.state.cardOffsets = this.store.document.columns.map(() => 0);
    this.clampState();
  }

  private clearStatus(): void {
    this.state.message = undefined;
    this.state.messageKind = undefined;
  }

  private bodyHeight(): number {
    return this.lastBodyRows;
  }
}
