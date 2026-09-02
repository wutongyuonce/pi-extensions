import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BOARD_MARKDOWN,
  ensureGlobalBoard,
  ensureProjectBoard,
  findExistingBoard,
  globalBoardPath,
  importScopedBoard,
  projectBoardPath,
} from "../src/project-board.js";

const createdDirectories: string[] = [];

function temporaryProject(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-kanban0-project-"));
  createdDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project-local board", () => {
  it("creates .pi/kanban.md on first use and never replaces it on reopen", () => {
    const cwd = temporaryProject();
    const first = ensureProjectBoard(cwd);

    expect(first).toEqual({ path: projectBoardPath(cwd), created: true });
    expect(readFileSync(first.path, "utf8")).toBe(DEFAULT_BOARD_MARKDOWN);

    writeFileSync(first.path, "## Personal\n\n- [ ] Keep me\n", "utf8");
    expect(ensureProjectBoard(cwd).created).toBe(false);
    expect(readFileSync(first.path, "utf8")).toContain("Keep me");
  });

  it("creates a namespaced global board inside Pi's agent directory", () => {
    const cwd = temporaryProject();
    const agentDir = join(cwd, "pi-agent-home");
    const location = ensureGlobalBoard(agentDir);

    expect(location).toEqual({ path: globalBoardPath(agentDir), created: true });
    expect(location.path).toBe(join(agentDir, "pi-kanban0", "kanban.md"));
    expect(readFileSync(location.path, "utf8")).toBe(DEFAULT_BOARD_MARKDOWN);
  });

  it("resolves project first, then global, without creating either", () => {
    const cwd = temporaryProject();
    const agentDir = join(cwd, "pi-agent-home");

    expect(findExistingBoard(cwd, agentDir)).toBeUndefined();
    const global = ensureGlobalBoard(agentDir);
    expect(findExistingBoard(cwd, agentDir)).toEqual({ ...global, created: false, scope: "global" });
    const project = ensureProjectBoard(cwd);
    expect(findExistingBoard(cwd, agentDir)).toEqual({ ...project, created: false, scope: "project" });
  });

  it("imports a legacy board into the project without changing the source", () => {
    const cwd = temporaryProject();
    const sourcePath = join(cwd, "legacy.md");
    const source = "## Ideas\r\n\r\n- [ ] Preserve this\r\n";
    writeFileSync(sourcePath, source, "utf8");

    const target = importScopedBoard("project", cwd, sourcePath);

    expect(readFileSync(sourcePath, "utf8")).toBe(source);
    expect(target).toEqual({ path: projectBoardPath(cwd), created: true, scope: "project" });
    expect(readFileSync(target.path, "utf8")).toBe(source);
  });

  it("imports a legacy board into the global scope", () => {
    const cwd = temporaryProject();
    const agentDir = join(cwd, "pi-agent-home");
    const sourcePath = join(cwd, "legacy.md");
    const source = "## Ideas\n\n- [ ] Shared card\n";
    writeFileSync(sourcePath, source, "utf8");

    const target = importScopedBoard("global", cwd, sourcePath, agentDir);

    expect(target).toEqual({ path: globalBoardPath(agentDir), created: true, scope: "global" });
    expect(readFileSync(target.path, "utf8")).toBe(source);
  });

  it("validates an import before replacing an existing project board", () => {
    const cwd = temporaryProject();
    const target = ensureProjectBoard(cwd).path;
    const invalidPath = join(cwd, "notes.md");
    writeFileSync(invalidPath, "# Notes\n- [ ] Not a board\n", "utf8");

    expect(() => importScopedBoard("project", cwd, invalidPath)).toThrow(/No Kanban columns/);
    expect(readFileSync(target, "utf8")).toBe(DEFAULT_BOARD_MARKDOWN);
  });
});
