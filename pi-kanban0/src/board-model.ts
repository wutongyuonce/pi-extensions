export type LineEnding = "\n" | "\r\n" | "\r";

export interface RawBlock {
  kind: "raw";
  raw: string;
}

export interface KanbanCard {
  kind: "card";
  id: string;
  raw: string;
  title: string;
  checked: boolean;
}

export type ColumnBlock = RawBlock | KanbanCard;

export interface KanbanColumn {
  id: string;
  title: string;
  headingRaw: string;
  blocks: ColumnBlock[];
}

export interface KanbanDocument {
  prefix: string;
  columns: KanbanColumn[];
  eol: LineEnding;
}

export function cardsIn(column: KanbanColumn): KanbanCard[] {
  return column.blocks.filter((block): block is KanbanCard => block.kind === "card");
}

export function cardCount(document: KanbanDocument): number {
  return document.columns.reduce((count, column) => count + cardsIn(column).length, 0);
}
