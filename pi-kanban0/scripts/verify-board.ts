import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cardCount, cardsIn } from "../src/board-model.ts";
import {
  moveCard,
  parseKanbanMarkdown,
  serializeKanbanMarkdown,
  toggleCard,
} from "../src/markdown-board.ts";

const argument = process.argv[2];
if (!argument) {
  console.error("Usage: npm run verify:board -- <board.md>");
  process.exit(2);
}

const boardPath = resolve(argument);
const source = readFileSync(boardPath, "utf8");
const document = parseKanbanMarkdown(source);
const roundTrip = serializeKanbanMarkdown(document);
if (roundTrip !== source) throw new Error("parse → serialize changed the board");

const reversible = parseKanbanMarkdown(source);
const reversibleCard = reversible.columns.flatMap(cardsIn)[0];
if (reversibleCard) {
  toggleCard(reversible, reversibleCard.id);
  toggleCard(reversible, reversibleCard.id);
  if (serializeKanbanMarkdown(reversible) !== source) {
    throw new Error("toggle → toggle did not restore the original board");
  }
}

const moveProbe = parseKanbanMarkdown(source);
const firstColumnWithCard = moveProbe.columns.findIndex((column) => cardsIn(column).length > 0);
if (firstColumnWithCard >= 0 && moveProbe.columns.length > 1) {
  const card = cardsIn(moveProbe.columns[firstColumnWithCard]!)[0]!;
  const target = (firstColumnWithCard + 1) % moveProbe.columns.length;
  moveCard(moveProbe, card.id, target);
  const movedSource = serializeKanbanMarkdown(moveProbe);
  const reparsed = parseKanbanMarkdown(movedSource);
  if (cardCount(reparsed) !== cardCount(document)) throw new Error("move probe changed card count");
  const settingsBefore = source.split("%% kanban:settings").length - 1;
  const settingsAfter = movedSource.split("%% kanban:settings").length - 1;
  if (settingsBefore !== settingsAfter) throw new Error("move probe changed legacy settings blocks");
}

console.log(JSON.stringify({
  ok: true,
  bytes: Buffer.byteLength(source),
  columns: document.columns.map((column) => column.title),
  cards: cardCount(document),
  lineEnding: document.eol === "\r\n" ? "CRLF" : document.eol === "\r" ? "CR" : "LF",
  bom: source.startsWith("\ufeff"),
}));
