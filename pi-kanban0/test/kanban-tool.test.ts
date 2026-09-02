import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cardsIn } from "../src/board-model.js";
import { BoardStore } from "../src/board-store.js";
import {
  resolveKanbanBoardLocation,
  runKanbanAction,
} from "../src/kanban-tool.js";
import { readCardMetadata } from "../src/markdown-board.js";
import {
  ensureGlobalBoard,
  ensureProjectBoard,
  projectBoardPath,
} from "../src/project-board.js";

const createdDirectories: string[] = [];

function temporaryDirectory(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-kanban0-tool-"));
  createdDirectories.push(cwd);
  return cwd;
}

function projectStore(): BoardStore {
  const cwd = temporaryDirectory();
  return new BoardStore(ensureProjectBoard(cwd).path);
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("kanban agent actions", () => {
  it("reads and changes the same project board used by the TUI", () => {
    const store = projectStore();

    expect(runKanbanAction(store, { action: "list" })).toContain("Kanban · project");
    expect(runKanbanAction(store, { action: "list" }, "global")).toContain("Kanban · global");
    expect(runKanbanAction(store, {
      action: "add_card",
      column: "Inbox",
      text: "Ship keyboard board\nKeep it local",
    })).toContain("Added");
    expect(runKanbanAction(store, {
      action: "move_card",
      card: "Ship keyboard board",
      targetColumn: "Todo",
    })).toContain("Moved");
    expect(runKanbanAction(store, {
      action: "set_done",
      card: "Ship keyboard board",
      column: "Todo",
      done: true,
    })).toContain("done");
    expect(runKanbanAction(store, {
      action: "set_time",
      card: "Ship keyboard board",
      column: "Todo",
      time: "2026-08-04 10:00",
    })).toContain("Set time");
    expect(runKanbanAction(store, {
      action: "add_label",
      card: "Ship keyboard board",
      column: "Todo",
      label: "release candidate",
    })).toContain("Added label");

    const todo = store.document.columns.find((column) => column.title === "Todo")!;
    expect(cardsIn(todo)[0]?.checked).toBe(true);
    expect(readCardMetadata(cardsIn(todo)[0]!)).toMatchObject({
      time: "2026-08-04 10:00",
      labels: ["release candidate"],
    });
    const compact = runKanbanAction(store, {
      action: "list",
      query: "keep it local",
    });
    expect(compact).toContain("Ship keyboard board");
    expect(compact).toContain("@{2026-08-04 10:00}");
    expect(compact).toContain("#{release candidate}");
    expect(compact).not.toContain("Body:");

    const detailed = runKanbanAction(store, {
      action: "list",
      column: "Todo",
      includeDetails: true,
    });
    expect(detailed).toContain("@{2026-08-04 10:00}");
    expect(detailed).toContain("#{release candidate}");
    expect(detailed).toContain("Body:\n    Keep it local");
    expect(detailed).not.toContain("\nInbox ");
  });

  it("resolves read-only boards without creating them and keeps auto fallback local-first", () => {
    const cwd = temporaryDirectory();
    const agentDir = join(cwd, "agent");
    const projectPath = projectBoardPath(cwd);

    expect(resolveKanbanBoardLocation({ action: "list", scope: "project" }, cwd, agentDir)).toBeUndefined();
    expect(existsSync(projectPath)).toBe(false);

    const global = ensureGlobalBoard(agentDir);
    expect(resolveKanbanBoardLocation({ action: "list", scope: "auto" }, cwd, agentDir)).toEqual({
      ...global,
      created: false,
      scope: "global",
    });
    expect(existsSync(projectPath)).toBe(false);

    const project = ensureProjectBoard(cwd);
    expect(resolveKanbanBoardLocation({ action: "list", scope: "auto" }, cwd, agentDir)).toEqual({
      ...project,
      created: false,
      scope: "project",
    });
  });

  it("creates an explicitly selected board only for a write action", () => {
    const cwd = temporaryDirectory();
    const agentDir = join(cwd, "agent");

    const location = resolveKanbanBoardLocation(
      { action: "add_card", scope: "project" },
      cwd,
      agentDir,
    );

    expect(location).toEqual({
      path: projectBoardPath(cwd),
      created: true,
      scope: "project",
    });
    expect(existsSync(projectBoardPath(cwd))).toBe(true);
  });

  it("supports column management and protects destructive ambiguous actions", () => {
    const store = projectStore();
    runKanbanAction(store, { action: "add_column", title: "Blocked", after: "Todo" });
    runKanbanAction(store, { action: "rename_column", column: "Blocked", title: "Waiting" });
    runKanbanAction(store, { action: "move_column", column: "Waiting", direction: "right" });

    expect(store.document.columns.map((column) => column.title)).toEqual([
      "Inbox",
      "Todo",
      "In Progress",
      "Waiting",
      "Review",
      "Done",
    ]);

    runKanbanAction(store, { action: "add_card", column: "Waiting", text: "External decision" });
    expect(() => runKanbanAction(store, { action: "delete_column", column: "Waiting" })).toThrow(/deleteCards=true/);
    expect(runKanbanAction(store, {
      action: "delete_column",
      column: "Waiting",
      deleteCards: true,
    })).toContain("and 1 card");
  });
});
