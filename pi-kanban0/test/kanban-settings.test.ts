import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultKanbanLayout,
  kanbanSettingsPath,
  loadKanbanLayout,
  normalizeKanbanLayout,
  saveKanbanLayout,
} from "../src/kanban-settings.js";

const createdDirectories: string[] = [];

function temporaryAgentDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-kanban0-settings-"));
  createdDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Kanban layout settings", () => {
  it("uses defaults for missing, malformed, and out-of-range values", () => {
    const agentDir = temporaryAgentDir();

    expect(loadKanbanLayout(agentDir)).toEqual(defaultKanbanLayout());
    expect(normalizeKanbanLayout({ boardHeight: 20, cardRows: 4 })).toEqual({
      boardHeight: 20,
      cardRows: 4,
    });
    expect(normalizeKanbanLayout({ boardHeight: 5, cardRows: 99 })).toEqual(
      defaultKanbanLayout(),
    );

    const path = kanbanSettingsPath(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json", "utf8");
    expect(loadKanbanLayout(agentDir)).toEqual(defaultKanbanLayout());
  });

  it("persists normalized settings under the Pi agent directory", () => {
    const agentDir = temporaryAgentDir();
    const saved = saveKanbanLayout({ boardHeight: 28, cardRows: 5 }, agentDir);
    const path = kanbanSettingsPath(agentDir);

    expect(dirname(path)).toBe(join(agentDir, "pi-kanban0"));
    expect(saved).toEqual({ boardHeight: 28, cardRows: 5 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(saved);
    expect(loadKanbanLayout(agentDir)).toEqual(saved);
  });
});
