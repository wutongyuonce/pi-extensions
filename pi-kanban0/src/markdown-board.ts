import type {
  ColumnBlock,
  KanbanCard,
  KanbanColumn,
  KanbanDocument,
  LineEnding,
  RawBlock,
} from "./board-model.js";
import { cardsIn } from "./board-model.js";

interface SourceLine {
  content: string;
  ending: string;
  raw: string;
}

interface HeadingLocation {
  index: number;
  title: string;
}

const CARD_PATTERN = /^([-*+]\s+\[)([ xX])(\])(?:[ \t]+(.*))?$/;
const CARD_MARKER_PATTERN = /^([-*+]\s+\[)([ xX])(\])/;
const HEADING_PATTERN = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/;
const TIME_METADATA_PATTERN = /^@\{(.+)\}$/;
const SIMPLE_LABEL_PATTERN = /^#([^\s#{}]+)$/;
const BRACED_LABEL_PATTERN = /^#\{(.+)\}$/;

export interface CardMetadata {
  time?: string;
  labels: string[];
  bodyLines: string[];
}

function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== "\n" && char !== "\r") continue;

    let ending = char;
    if (char === "\r" && source[index + 1] === "\n") {
      ending = "\r\n";
      index += 1;
    }

    const end = index + 1;
    const contentEnd = end - ending.length;
    lines.push({
      content: source.slice(start, contentEnd),
      ending,
      raw: source.slice(start, end),
    });
    start = end;
  }

  if (start < source.length) {
    lines.push({ content: source.slice(start), ending: "", raw: source.slice(start) });
  }

  return lines;
}

function detectLineEnding(lines: SourceLine[]): LineEnding {
  const first = lines.find((line) => line.ending.length > 0)?.ending;
  if (first === "\r\n" || first === "\r") return first;
  return "\n";
}

function headingTitle(content: string): string | undefined {
  const match = content.match(HEADING_PATTERN);
  const title = match?.[1]?.trim();
  return title || undefined;
}

function findHeadings(lines: SourceLine[]): HeadingLocation[] {
  const headings: HeadingLocation[] = [];
  let activeFence: { marker: "`" | "~"; length: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index]?.content ?? "";
    const fence = content.match(FENCE_PATTERN)?.[1];

    if (fence) {
      const marker = fence[0] as "`" | "~";
      if (!activeFence) {
        activeFence = { marker, length: fence.length };
      } else if (activeFence.marker === marker && fence.length >= activeFence.length) {
        activeFence = undefined;
      }
      continue;
    }

    if (activeFence) continue;
    const title = headingTitle(content);
    if (title) headings.push({ index, title });
  }

  return headings;
}

function rawBlock(raw: string): RawBlock {
  return { kind: "raw", raw };
}

function cardFromRaw(raw: string, id: string): KanbanCard {
  const firstLine = splitSourceLines(raw)[0]?.content ?? raw;
  const match = firstLine.match(CARD_PATTERN);
  if (!match) throw new Error("Invalid card block: missing Markdown task marker");

  return {
    kind: "card",
    id,
    raw,
    title: (match[4] ?? "").trim(),
    checked: match[2]?.toLowerCase() === "x",
  };
}

function parseColumnBlocks(lines: SourceLine[], columnIndex: number): ColumnBlock[] {
  const blocks: ColumnBlock[] = [];
  let rawLines: SourceLine[] = [];
  let cardLines: SourceLine[] | undefined;
  let pendingBlankLines: SourceLine[] = [];
  let cardIndex = 0;

  const flushRaw = () => {
    if (rawLines.length === 0) return;
    blocks.push(rawBlock(rawLines.map((line) => line.raw).join("")));
    rawLines = [];
  };

  const flushCard = (includePendingBlanks: boolean) => {
    if (!cardLines) return;
    if (includePendingBlanks) {
      cardLines.push(...pendingBlankLines);
      pendingBlankLines = [];
    }
    const raw = cardLines.map((line) => line.raw).join("");
    blocks.push(cardFromRaw(raw, `card:${columnIndex}:${cardIndex}`));
    cardIndex += 1;
    cardLines = undefined;
  };

  for (const line of lines) {
    const isCard = CARD_PATTERN.test(line.content);
    const isBlank = line.content.trim().length === 0;
    const isIndented = /^[ \t]/.test(line.content);

    if (isCard) {
      if (cardLines) flushCard(true);
      flushRaw();
      cardLines = [line];
      continue;
    }

    if (cardLines) {
      if (isBlank) {
        pendingBlankLines.push(line);
        continue;
      }

      if (isIndented) {
        cardLines.push(...pendingBlankLines, line);
        pendingBlankLines = [];
        continue;
      }

      flushCard(false);
      rawLines.push(...pendingBlankLines, line);
      pendingBlankLines = [];
      continue;
    }

    rawLines.push(line);
  }

  if (cardLines) flushCard(false);
  rawLines.push(...pendingBlankLines);
  flushRaw();
  return blocks;
}

export function parseKanbanMarkdown(source: string): KanbanDocument {
  const lines = splitSourceLines(source);
  const headings = findHeadings(lines);
  if (headings.length === 0) {
    throw new Error("No Kanban columns found (expected top-level '## Column' headings)");
  }

  const prefix = lines
    .slice(0, headings[0]?.index ?? 0)
    .map((line) => line.raw)
    .join("");

  const columns: KanbanColumn[] = headings.map((heading, columnIndex) => {
    const nextHeadingIndex = headings[columnIndex + 1]?.index ?? lines.length;
    const headingLine = lines[heading.index];
    if (!headingLine) throw new Error("Invalid heading position while parsing board");

    return {
      id: `column:${columnIndex}`,
      title: heading.title,
      headingRaw: headingLine.raw,
      blocks: parseColumnBlocks(lines.slice(heading.index + 1, nextHeadingIndex), columnIndex),
    };
  });

  return { prefix, columns, eol: detectLineEnding(lines) };
}

export function serializeKanbanMarkdown(document: KanbanDocument): string {
  return (
    document.prefix +
    document.columns
      .map((column) => column.headingRaw + column.blocks.map((block) => block.raw).join(""))
      .join("")
  );
}

export function findCard(document: KanbanDocument, cardId: string): {
  column: KanbanColumn;
  columnIndex: number;
  card: KanbanCard;
  blockIndex: number;
  cardIndex: number;
} | undefined {
  for (let columnIndex = 0; columnIndex < document.columns.length; columnIndex += 1) {
    const column = document.columns[columnIndex];
    if (!column) continue;
    let cardIndex = 0;
    for (let blockIndex = 0; blockIndex < column.blocks.length; blockIndex += 1) {
      const block = column.blocks[blockIndex];
      if (block?.kind !== "card") continue;
      if (block.id === cardId) return { column, columnIndex, card: block, blockIndex, cardIndex };
      cardIndex += 1;
    }
  }
  return undefined;
}

function cardMarker(raw: string): { prefix: string; suffix: string } {
  const firstLine = splitSourceLines(raw)[0]?.content ?? raw;
  const match = firstLine.match(CARD_PATTERN);
  if (!match) return { prefix: "- [", suffix: "]" };
  return { prefix: match[1] ?? "- [", suffix: match[3] ?? "]" };
}

export function toggleCard(document: KanbanDocument, cardId: string): boolean {
  const found = findCard(document, cardId);
  if (!found) return false;
  return setCardChecked(document, cardId, !found.card.checked);
}

export function setCardChecked(
  document: KanbanDocument,
  cardId: string,
  checked: boolean,
): boolean {
  const found = findCard(document, cardId);
  if (!found) return false;
  if (found.card.checked === checked) return true;
  found.card.raw = found.card.raw.replace(
    CARD_MARKER_PATTERN,
    (_marker, prefix: string, _state: string, suffix: string) => `${prefix}${checked ? "x" : " "}${suffix}`,
  );
  found.card.checked = checked;
  return true;
}

function splitTrailingBlankLines(raw: string): { body: SourceLine[]; trailing: SourceLine[] } {
  const lines = splitSourceLines(raw);
  let splitAt = lines.length;
  while (splitAt > 1 && (lines[splitAt - 1]?.content.trim().length ?? 1) === 0) splitAt -= 1;
  return { body: lines.slice(0, splitAt), trailing: lines.slice(splitAt) };
}

export function cardToEditableText(card: KanbanCard): string {
  const { body } = splitTrailingBlankLines(card.raw);
  const first = body[0]?.content.match(CARD_PATTERN)?.[4] ?? card.title;
  const continuation = body.slice(1).map((line) => {
    if (line.content.startsWith("\t")) return line.content.slice(1);
    if (line.content.startsWith("    ")) return line.content.slice(4);
    return line.content.replace(/^ +/, "");
  });
  return [first, ...continuation].join("\n").replace(/\n+$/, "");
}

function metadataLine(value: string): { type: "time" | "label"; value: string } | undefined {
  const trimmed = value.trim();
  const time = trimmed.match(TIME_METADATA_PATTERN)?.[1]?.trim();
  if (time) return { type: "time", value: time };
  const label = (
    trimmed.match(BRACED_LABEL_PATTERN)?.[1]
    ?? trimmed.match(SIMPLE_LABEL_PATTERN)?.[1]
  )?.trim();
  return label ? { type: "label", value: label } : undefined;
}

export function cardToClipboardText(card: KanbanCard): string {
  const [title = card.title, ...lines] = cardToEditableText(card).split("\n");
  return [title, ...lines.filter((line) => !metadataLine(line))]
    .join("\n")
    .replace(/\n+$/, "");
}

export function readCardMetadata(card: KanbanCard): CardMetadata {
  const lines = cardToEditableText(card).split("\n");
  const metadata: CardMetadata = { labels: [], bodyLines: [] };
  for (const line of lines.slice(1)) {
    const parsed = metadataLine(line);
    if (parsed?.type === "time") {
      metadata.time ??= parsed.value;
    } else if (parsed?.type === "label") {
      metadata.labels.push(parsed.value);
    } else {
      metadata.bodyLines.push(line);
    }
  }
  return metadata;
}

function singleLineMetadataValue(value: string, kind: "time" | "label"): string {
  let normalized = value.trim();
  if (kind === "time" && normalized.startsWith("@{") && normalized.endsWith("}")) {
    normalized = normalized.slice(2, -1).trim();
  }
  if (kind === "label") {
    if (normalized.startsWith("#{") && normalized.endsWith("}")) {
      normalized = normalized.slice(2, -1).trim();
    } else if (normalized.startsWith("#")) {
      normalized = normalized.slice(1).trim();
    }
  }
  if (!normalized) throw new Error(`Card ${kind} cannot be empty`);
  if (/[\r\n]/.test(normalized)) throw new Error(`Card ${kind} must be a single line`);
  if (/[{}]/.test(normalized)) throw new Error(`Card ${kind} cannot contain braces`);
  return normalized;
}

export function setCardTime(
  document: KanbanDocument,
  cardId: string,
  value: string,
): boolean {
  const found = findCard(document, cardId);
  if (!found) return false;
  const normalized = singleLineMetadataValue(value, "time");
  const lines = cardToEditableText(found.card).split("\n");
  const withoutExisting = [
    lines[0] ?? found.card.title,
    ...lines.slice(1).filter((line) => metadataLine(line)?.type !== "time"),
  ];
  withoutExisting.splice(1, 0, `@{${normalized}}`);
  return updateCardFromEditableText(document, cardId, withoutExisting.join("\n"));
}

export function addCardLabel(
  document: KanbanDocument,
  cardId: string,
  value: string,
): boolean {
  const found = findCard(document, cardId);
  if (!found) return false;
  const normalized = singleLineMetadataValue(value, "label");
  const metadata = readCardMetadata(found.card);
  if (metadata.labels.some((label) => label.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    return true;
  }

  const lines = cardToEditableText(found.card).split("\n");
  let insertAt = 1;
  while (insertAt < lines.length && metadataLine(lines[insertAt] ?? "")) insertAt += 1;
  const formatted = /\s/.test(normalized) ? `#{${normalized}}` : `#${normalized}`;
  lines.splice(insertAt, 0, formatted);
  return updateCardFromEditableText(document, cardId, lines.join("\n"));
}

function normalizeEditableLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 1 && lines[lines.length - 1]?.trim().length === 0) lines.pop();
  return lines;
}

export function updateCardFromEditableText(
  document: KanbanDocument,
  cardId: string,
  editableText: string,
): boolean {
  const found = findCard(document, cardId);
  if (!found) return false;
  const lines = normalizeEditableLines(editableText);
  const title = lines[0]?.trim();
  if (!title) throw new Error("Card title cannot be empty");

  const { trailing } = splitTrailingBlankLines(found.card.raw);
  const marker = cardMarker(found.card.raw);
  const checked = found.card.checked ? "x" : " ";
  const firstLine = `${marker.prefix}${checked}${marker.suffix} ${title}${document.eol}`;
  const continuation = lines
    .slice(1)
    .map((line) => (line.length === 0 ? document.eol : `\t${line}${document.eol}`))
    .join("");
  found.card.raw = firstLine + continuation + trailing.map((line) => line.raw).join("");
  found.card.title = title;
  return true;
}

function insertionIndex(column: KanbanColumn): number {
  let lastCard = -1;
  for (let index = 0; index < column.blocks.length; index += 1) {
    if (column.blocks[index]?.kind === "card") lastCard = index;
  }
  if (lastCard >= 0) return lastCard + 1;

  const settingsIndex = column.blocks.findIndex(
    (block) => block.kind === "raw" && block.raw.includes("%% kanban:settings"),
  );
  return settingsIndex >= 0 ? settingsIndex : column.blocks.length;
}

function ensureSpaceBeforeFirstCard(column: KanbanColumn, index: number, eol: LineEnding): number {
  if (index > 0) return index;
  if (/\r\n\r\n$|\n\n$|\r\r$/.test(column.headingRaw)) return index;
  column.blocks.splice(0, 0, rawBlock(eol));
  return index + 1;
}

let generatedCardId = 0;

export function addCard(document: KanbanDocument, columnIndex: number, editableText: string): KanbanCard {
  const column = document.columns[columnIndex];
  if (!column) throw new Error(`Column ${columnIndex + 1} does not exist`);
  const lines = normalizeEditableLines(editableText);
  const title = lines[0]?.trim();
  if (!title) throw new Error("Card title cannot be empty");

  const raw =
    `- [ ] ${title}${document.eol}` +
    lines
      .slice(1)
      .map((line) => (line.length === 0 ? document.eol : `\t${line}${document.eol}`))
      .join("");
  const card = cardFromRaw(raw, `card:new:${process.pid}:${generatedCardId++}`);
  const index = ensureSpaceBeforeFirstCard(column, insertionIndex(column), document.eol);
  column.blocks.splice(index, 0, card);
  return card;
}

export function deleteCard(document: KanbanDocument, cardId: string): boolean {
  const found = findCard(document, cardId);
  if (!found) return false;
  found.column.blocks.splice(found.blockIndex, 1);
  return true;
}

export function moveCard(
  document: KanbanDocument,
  cardId: string,
  targetColumnIndex: number,
): boolean {
  const found = findCard(document, cardId);
  const target = document.columns[targetColumnIndex];
  if (!found || !target || found.columnIndex === targetColumnIndex) return false;

  found.column.blocks.splice(found.blockIndex, 1);
  const index = ensureSpaceBeforeFirstCard(target, insertionIndex(target), document.eol);
  target.blocks.splice(index, 0, found.card);
  return true;
}

export function reorderCard(document: KanbanDocument, cardId: string, delta: -1 | 1): boolean {
  const found = findCard(document, cardId);
  if (!found) return false;
  const cards = cardsIn(found.column);
  const currentCardIndex = cards.findIndex((card) => card.id === cardId);
  const targetCard = cards[currentCardIndex + delta];
  if (!targetCard) return false;

  const targetBlockIndex = found.column.blocks.findIndex(
    (block) => block.kind === "card" && block.id === targetCard.id,
  );
  if (targetBlockIndex < 0) return false;
  const current = found.column.blocks[found.blockIndex];
  const target = found.column.blocks[targetBlockIndex];
  if (!current || !target) return false;
  found.column.blocks[found.blockIndex] = target;
  found.column.blocks[targetBlockIndex] = current;
  return true;
}

function validatedColumnTitle(title: string): string {
  const value = title.trim();
  if (!value) throw new Error("Column title cannot be empty");
  if (/[\r\n]/.test(value)) throw new Error("Column title must be a single line");
  return value;
}

function assertUniqueColumnTitle(
  document: KanbanDocument,
  title: string,
  exceptIndex = -1,
): void {
  const normalized = title.toLocaleLowerCase();
  const duplicate = document.columns.some(
    (column, index) => index !== exceptIndex && column.title.toLocaleLowerCase() === normalized,
  );
  if (duplicate) throw new Error(`A column named “${title}” already exists`);
}

function appendEolToColumn(column: KanbanColumn, eol: LineEnding): void {
  const last = column.blocks[column.blocks.length - 1];
  if (last) last.raw += eol;
  else column.headingRaw += eol;
}

function ensureColumnBoundaries(document: KanbanDocument): void {
  for (let index = 0; index < document.columns.length - 1; index += 1) {
    const column = document.columns[index];
    if (!column) continue;
    const last = column.blocks[column.blocks.length - 1];
    const sourceEnd = last?.raw ?? column.headingRaw;
    if (!sourceEnd.endsWith("\n") && !sourceEnd.endsWith("\r")) {
      appendEolToColumn(column, document.eol);
    }
  }
}

let generatedColumnId = 0;

export function addColumn(
  document: KanbanDocument,
  title: string,
  afterColumnIndex = document.columns.length - 1,
): KanbanColumn {
  const value = validatedColumnTitle(title);
  assertUniqueColumnTitle(document, value);
  const insertIndex = Math.max(0, Math.min(afterColumnIndex + 1, document.columns.length));
  const column: KanbanColumn = {
    id: `column:new:${process.pid}:${generatedColumnId++}`,
    title: value,
    headingRaw: `## ${value}${document.eol}`,
    blocks: [rawBlock(document.eol)],
  };
  document.columns.splice(insertIndex, 0, column);
  ensureColumnBoundaries(document);
  return column;
}

export function renameColumn(
  document: KanbanDocument,
  columnIndex: number,
  title: string,
): boolean {
  const column = document.columns[columnIndex];
  if (!column) return false;
  const value = validatedColumnTitle(title);
  if (column.title === value) return true;
  assertUniqueColumnTitle(document, value, columnIndex);
  const ending = column.headingRaw.match(/(\r\n|\n|\r)$/)?.[1] ?? "";
  column.title = value;
  column.headingRaw = `## ${value}${ending}`;
  return true;
}

export function moveColumn(
  document: KanbanDocument,
  columnIndex: number,
  targetIndex: number,
): boolean {
  if (
    columnIndex < 0 ||
    columnIndex >= document.columns.length ||
    targetIndex < 0 ||
    targetIndex >= document.columns.length ||
    columnIndex === targetIndex
  ) {
    return false;
  }
  const [column] = document.columns.splice(columnIndex, 1);
  if (!column) return false;
  document.columns.splice(targetIndex, 0, column);
  ensureColumnBoundaries(document);
  return true;
}

export function deleteColumn(document: KanbanDocument, columnIndex: number): boolean {
  if (document.columns.length <= 1 || !document.columns[columnIndex]) return false;
  document.columns.splice(columnIndex, 1);
  ensureColumnBoundaries(document);
  return true;
}
