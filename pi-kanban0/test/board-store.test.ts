import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cardsIn } from "../src/board-model.js";
import { BoardConflictError, BoardStore } from "../src/board-store.js";
import { serializeKanbanMarkdown, toggleCard } from "../src/markdown-board.js";

const createdDirectories: string[] = [];

function createBoard(source = "## TODO\n\n- [ ] Test\n"): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-kanban0-test-"));
  createdDirectories.push(directory);
  const path = join(directory, "board.md");
  writeFileSync(path, source, "utf8");
  return path;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("BoardStore", () => {
  it("persists a mutation through a same-directory atomic replacement", () => {
    const path = createBoard();
    const store = new BoardStore(path);
    const card = cardsIn(store.document.columns[0]!)[0]!;

    store.mutate((document) => {
      toggleCard(document, card.id);
    });

    expect(readFileSync(path, "utf8")).toContain("- [x] Test");
    expect(readFileSync(path, "utf8")).toBe(serializeKanbanMarkdown(store.document));
  });

  it("refuses to overwrite an external file edit", () => {
    const original = "## TODO\n\n- [ ] Test\n";
    const path = createBoard(original);
    const store = new BoardStore(path);
    const external = "## TODO\n\n- [ ] Test\n- [ ] Added outside Pi\n";
    writeFileSync(path, external, "utf8");

    expect(() => store.mutate((document) => {
      const card = cardsIn(document.columns[0]!)[0]!;
      toggleCard(document, card.id);
    })).toThrow(BoardConflictError);

    expect(readFileSync(path, "utf8")).toBe(external);
    expect(serializeKanbanMarkdown(store.document)).toBe(original);
  });

  it("reloads external changes explicitly", () => {
    const path = createBoard();
    const store = new BoardStore(path);
    writeFileSync(path, "## TODO\n\n- [ ] First\n- [ ] Second\n", "utf8");

    store.reload();

    expect(cardsIn(store.document.columns[0]!)).toHaveLength(2);
  });
});
