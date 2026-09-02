import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KanbanDocument } from "./board-model.js";
import { parseKanbanMarkdown, serializeKanbanMarkdown } from "./markdown-board.js";

export class BoardConflictError extends Error {
  constructor(readonly boardPath: string) {
    super(`Board changed on disk: ${boardPath}`);
    this.name = "BoardConflictError";
  }
}

export class BoardStore {
  private snapshot = "";
  private currentDocument: KanbanDocument;

  constructor(readonly path: string) {
    const source = readFileSync(path, "utf8");
    this.snapshot = source;
    this.currentDocument = parseKanbanMarkdown(source);
  }

  get document(): KanbanDocument {
    return this.currentDocument;
  }

  reload(): KanbanDocument {
    const source = readFileSync(this.path, "utf8");
    this.currentDocument = parseKanbanMarkdown(source);
    this.snapshot = source;
    return this.currentDocument;
  }

  mutate(mutator: (document: KanbanDocument) => void): KanbanDocument {
    const diskSource = readFileSync(this.path, "utf8");
    if (diskSource !== this.snapshot) throw new BoardConflictError(this.path);

    const before = serializeKanbanMarkdown(this.currentDocument);
    try {
      mutator(this.currentDocument);
      const next = serializeKanbanMarkdown(this.currentDocument);
      if (next === before) return this.currentDocument;
      this.writeAtomically(next);
      this.snapshot = next;
      return this.currentDocument;
    } catch (error) {
      this.currentDocument = parseKanbanMarkdown(before);
      throw error;
    }
  }

  private writeAtomically(source: string): void {
    const tempPath = join(dirname(this.path), `.pi-kanban0-${process.pid}-${Date.now()}.tmp`);
    try {
      writeFileSync(tempPath, source, "utf8");
      renameSync(tempPath, this.path);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best effort cleanup; the original board remains untouched if rename failed.
      }
      throw error;
    }
  }
}
