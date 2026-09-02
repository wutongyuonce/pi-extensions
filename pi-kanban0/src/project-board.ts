import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseKanbanMarkdown } from "./markdown-board.js";

export const PROJECT_BOARD_RELATIVE_PATH = join(".pi", "kanban.md");
export const GLOBAL_BOARD_RELATIVE_PATH = join("pi-kanban0", "kanban.md");

export type BoardScope = "project" | "global";

export const DEFAULT_BOARD_MARKDOWN = [
  "# Pi Kanban\n",
  "\n",
  "## Inbox\n",
  "\n",
  "## Todo\n",
  "\n",
  "## In Progress\n",
  "\n",
  "## Review\n",
  "\n",
  "## Done\n",
  "\n",
].join("");

export interface ProjectBoardLocation {
  path: string;
  created: boolean;
}

export interface ScopedBoardLocation extends ProjectBoardLocation {
  scope: BoardScope;
}

export function projectBoardPath(cwd: string): string {
  return resolve(cwd, PROJECT_BOARD_RELATIVE_PATH);
}

export function globalBoardPath(agentDir = getAgentDir()): string {
  return resolve(agentDir, GLOBAL_BOARD_RELATIVE_PATH);
}

export function resolveImportPath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function ensureBoardAt(path: string): ProjectBoardLocation {
  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(path, DEFAULT_BOARD_MARKDOWN, { encoding: "utf8", flag: "wx" });
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { path, created: false };
  }
}

export function ensureProjectBoard(cwd: string): ProjectBoardLocation {
  return ensureBoardAt(projectBoardPath(cwd));
}

export function ensureGlobalBoard(agentDir = getAgentDir()): ProjectBoardLocation {
  return ensureBoardAt(globalBoardPath(agentDir));
}

export function ensureScopedBoard(
  scope: BoardScope,
  cwd: string,
  agentDir = getAgentDir(),
): ScopedBoardLocation {
  const location = scope === "project" ? ensureProjectBoard(cwd) : ensureGlobalBoard(agentDir);
  return { ...location, scope };
}

export function findScopedBoard(
  scope: BoardScope,
  cwd: string,
  agentDir = getAgentDir(),
): ScopedBoardLocation | undefined {
  const path = scope === "project" ? projectBoardPath(cwd) : globalBoardPath(agentDir);
  return existsSync(path) ? { path, created: false, scope } : undefined;
}

export function findExistingBoard(
  cwd: string,
  agentDir = getAgentDir(),
): ScopedBoardLocation | undefined {
  return (
    findScopedBoard("project", cwd, agentDir)
    ?? findScopedBoard("global", cwd, agentDir)
  );
}

/**
 * Copy a legacy Markdown board into the selected scope after validating it.
 * The source is never changed; the destination is replaced atomically.
 */
export function importScopedBoard(
  scope: BoardScope,
  cwd: string,
  sourcePath: string,
  agentDir = getAgentDir(),
): ScopedBoardLocation {
  const source = readFileSync(sourcePath, "utf8");
  parseKanbanMarkdown(source);

  const targetPath = scope === "project" ? projectBoardPath(cwd) : globalBoardPath(agentDir);
  const created = !existsSync(targetPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = join(dirname(targetPath), `.pi-kanban0-import-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, source, "utf8");
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; either the old target or no target remains intact.
    }
    throw error;
  }
  return { path: targetPath, created, scope };
}
