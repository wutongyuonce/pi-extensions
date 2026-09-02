import { describe, expect, it } from "vitest";
import { cardsIn } from "../src/board-model.js";
import {
  addCard,
  addCardLabel,
  addColumn,
  cardToClipboardText,
  cardToEditableText,
  deleteCard,
  deleteColumn,
  moveCard,
  moveColumn,
  parseKanbanMarkdown,
  reorderCard,
  renameColumn,
  readCardMetadata,
  serializeKanbanMarkdown,
  setCardChecked,
  setCardTime,
  toggleCard,
  updateCardFromEditableText,
} from "../src/markdown-board.js";

const LF_BOARD = [
  "---\n",
  "kanban-plugin: board\n",
  "---\n",
  "\n",
  "## TODO\n",
  "\n",
  "- [ ] First card\n",
  "\tA detail line\n",
  "\t- nested item\n",
  "\t@{2026-08/03}\n",
  "\n",
  "- [x] Finished card\n",
  "\n",
  "## Doing\n",
  "\n",
  "- [ ] Work in progress\n",
  "\t```ts\n",
  "\t## this is code, not a column\n",
  "\t```\n",
  "\n",
  "## Archive\n",
  "\n",
  "- [ ] Old card 2026-07-10 09:32\n",
  "\n",
  "%% kanban:settings\n",
  "```\n",
  '{"kanban-plugin":"board","show-checkboxes":false}\n',
  "```\n",
  "%%\n",
].join("");

describe("Kanban Markdown", () => {
  it("round-trips a representative board byte-for-byte", () => {
    const document = parseKanbanMarkdown(LF_BOARD);

    expect(document.columns.map((column) => column.title)).toEqual(["TODO", "Doing", "Archive"]);
    expect(cardsIn(document.columns[0]!).map((card) => [card.title, card.checked])).toEqual([
      ["First card", false],
      ["Finished card", true],
    ]);
    expect(serializeKanbanMarkdown(document)).toBe(LF_BOARD);
  });

  it("keeps settings and top-level raw content outside the final card", () => {
    const document = parseKanbanMarkdown(LF_BOARD);
    const archive = document.columns[2]!;
    const card = cardsIn(archive)[0]!;
    const raw = archive.blocks.find((block) => block.kind === "raw" && block.raw.includes("kanban:settings"));

    expect(card.raw).not.toContain("kanban:settings");
    expect(raw?.raw).toContain("%% kanban:settings");
  });

  it("ignores headings inside top-level fenced code and supports duplicate column names", () => {
    const source = [
      "```md\n",
      "## Not a column\n",
      "```\n",
      "## Archive\n",
      "- [ ] One\n",
      "## Archive\n",
      "- [ ] Two\n",
    ].join("");
    const document = parseKanbanMarkdown(source);

    expect(document.columns.map((column) => column.title)).toEqual(["Archive", "Archive"]);
    expect(document.columns[0]?.id).not.toBe(document.columns[1]?.id);
    expect(serializeKanbanMarkdown(document)).toBe(source);
  });

  it("preserves UTF-8 BOM and CRLF line endings", () => {
    const source = "\ufeff---\r\nkanban-plugin: board\r\n---\r\n\r\n## 待办\r\n\r\n- [ ] 中文卡片\r\n";
    const document = parseKanbanMarkdown(source);

    expect(document.eol).toBe("\r\n");
    expect(serializeKanbanMarkdown(document)).toBe(source);
  });

  it("toggles only the checkbox marker", () => {
    const document = parseKanbanMarkdown(LF_BOARD);
    const card = cardsIn(document.columns[0]!)[0]!;
    const beforeBody = card.raw.slice(card.raw.indexOf("\n"));

    expect(toggleCard(document, card.id)).toBe(true);
    expect(card.checked).toBe(true);
    expect(card.raw).toMatch(/^- \[x\] First card/);
    expect(card.raw.slice(card.raw.indexOf("\n"))).toBe(beforeBody);
  });

  it("sets completion idempotently for agent retries", () => {
    const document = parseKanbanMarkdown(LF_BOARD);
    const card = cardsIn(document.columns[0]!)[0]!;

    expect(setCardChecked(document, card.id, true)).toBe(true);
    const once = serializeKanbanMarkdown(document);
    expect(setCardChecked(document, card.id, true)).toBe(true);
    expect(serializeKanbanMarkdown(document)).toBe(once);
  });

  it("converts a multiline card to and from the editor representation", () => {
    const document = parseKanbanMarkdown(LF_BOARD);
    const card = cardsIn(document.columns[0]!)[0]!;

    expect(cardToEditableText(card)).toBe("First card\nA detail line\n- nested item\n@{2026-08/03}");
    expect(updateCardFromEditableText(document, card.id, "Renamed\nBody\n\nSecond paragraph")).toBe(true);
    expect(card.title).toBe("Renamed");
    expect(card.raw).toContain("- [ ] Renamed\n\tBody\n\n\tSecond paragraph\n");
  });

  it("stores @ time and # labels as indented card metadata without changing the title", () => {
    const document = parseKanbanMarkdown(LF_BOARD);
    const card = cardsIn(document.columns[0]!)[0]!;

    expect(setCardTime(document, card.id, "2026-08-04 09:30")).toBe(true);
    expect(addCardLabel(document, card.id, "urgent")).toBe(true);
    expect(addCardLabel(document, card.id, "needs review")).toBe(true);
    expect(addCardLabel(document, card.id, "#URGENT")).toBe(true);

    expect(card.title).toBe("First card");
    expect(readCardMetadata(card)).toEqual({
      time: "2026-08-04 09:30",
      labels: ["urgent", "needs review"],
      bodyLines: ["A detail line", "- nested item"],
    });
    expect(cardToEditableText(card)).toBe([
      "First card",
      "@{2026-08-04 09:30}",
      "#urgent",
      "#{needs review}",
      "A detail line",
      "- nested item",
    ].join("\n"));
    expect(cardToClipboardText(card)).toBe([
      "First card",
      "A detail line",
      "- nested item",
    ].join("\n"));

    const reparsed = parseKanbanMarkdown(serializeKanbanMarkdown(document));
    expect(readCardMetadata(cardsIn(reparsed.columns[0]!)[0]!)).toEqual(readCardMetadata(card));
  });

  it("validates time and label metadata as single-line values", () => {
    const document = parseKanbanMarkdown(LF_BOARD);
    const card = cardsIn(document.columns[0]!)[0]!;

    expect(() => setCardTime(document, card.id, "tomorrow\nnoon")).toThrow(/single line/);
    expect(() => addCardLabel(document, card.id, "bad{label")).toThrow(/braces/);
  });

  it("adds, moves, reorders, and deletes cards without moving the settings block", () => {
    const document = parseKanbanMarkdown(LF_BOARD);
    const added = addCard(document, 1, "New work\nMore context");
    const first = cardsIn(document.columns[0]!)[0]!;

    expect(moveCard(document, first.id, 1)).toBe(true);
    expect(cardsIn(document.columns[1]!).map((card) => card.id)).toContain(first.id);
    expect(reorderCard(document, first.id, -1)).toBe(true);
    expect(deleteCard(document, added.id)).toBe(true);

    const output = serializeKanbanMarkdown(document);
    expect(output.indexOf("%% kanban:settings")).toBeGreaterThan(output.indexOf("- [ ] Old card"));
    expect(parseKanbanMarkdown(output).columns).toHaveLength(3);
  });

  it("inserts a first card before Obsidian settings in an otherwise empty final column", () => {
    const source = "## Empty\n\n%% kanban:settings\n```\n{}\n```\n%%\n";
    const document = parseKanbanMarkdown(source);
    addCard(document, 0, "First");
    const output = serializeKanbanMarkdown(document);

    expect(output).toContain("## Empty\n\n- [ ] First\n\n%% kanban:settings");
  });

  it("adds, renames, moves, and deletes columns while keeping Markdown parseable", () => {
    const document = parseKanbanMarkdown("## One\n\n- [ ] A\n## Two");

    addColumn(document, "Review", 0);
    renameColumn(document, 2, "Done");
    moveColumn(document, 1, 0);
    deleteColumn(document, 2);

    expect(document.columns.map((column) => column.title)).toEqual(["Review", "One"]);
    expect(cardsIn(document.columns[1]!)[0]?.title).toBe("A");
    expect(parseKanbanMarkdown(serializeKanbanMarkdown(document)).columns.map((column) => column.title))
      .toEqual(["Review", "One"]);
    expect(() => addColumn(document, "one")).toThrow(/already exists/);
    expect(deleteColumn(document, 1)).toBe(true);
    expect(deleteColumn(document, 0)).toBe(false);
  });

  it("rejects files without top-level H2 columns", () => {
    expect(() => parseKanbanMarkdown("# Notes\n- [ ] task\n")).toThrow(/No Kanban columns/);
  });
});
