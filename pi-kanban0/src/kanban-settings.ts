import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const KANBAN_SETTINGS_RELATIVE_PATH = join("pi-kanban0", "settings.json");
export const MIN_BOARD_HEIGHT = 6;
export const MAX_BOARD_HEIGHT = 100;
export const MIN_CARD_ROWS = 1;
export const MAX_CARD_ROWS = 12;

export interface KanbanLayoutSettings {
  boardHeight: "auto" | number;
  cardRows: number;
}

export const DEFAULT_KANBAN_LAYOUT: Readonly<KanbanLayoutSettings> = Object.freeze({
  boardHeight: "auto",
  cardRows: 2,
});

export function defaultKanbanLayout(): KanbanLayoutSettings {
  return { ...DEFAULT_KANBAN_LAYOUT };
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minimum
    && value <= maximum;
}

export function normalizeKanbanLayout(value: unknown): KanbanLayoutSettings {
  const normalized = defaultKanbanLayout();
  if (!value || typeof value !== "object") return normalized;

  const candidate = value as Partial<KanbanLayoutSettings>;
  if (
    candidate.boardHeight === "auto"
    || integerInRange(candidate.boardHeight, MIN_BOARD_HEIGHT, MAX_BOARD_HEIGHT)
  ) {
    normalized.boardHeight = candidate.boardHeight;
  }
  if (integerInRange(candidate.cardRows, MIN_CARD_ROWS, MAX_CARD_ROWS)) {
    normalized.cardRows = candidate.cardRows;
  }
  return normalized;
}

export function kanbanSettingsPath(agentDir = getAgentDir()): string {
  return resolve(agentDir, KANBAN_SETTINGS_RELATIVE_PATH);
}

export function loadKanbanLayout(agentDir = getAgentDir()): KanbanLayoutSettings {
  const path = kanbanSettingsPath(agentDir);
  try {
    return normalizeKanbanLayout(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return defaultKanbanLayout();
    }
    throw error;
  }
}

export function saveKanbanLayout(
  settings: KanbanLayoutSettings,
  agentDir = getAgentDir(),
): KanbanLayoutSettings {
  const normalized = normalizeKanbanLayout(settings);
  const path = kanbanSettingsPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.pi-kanban0-settings-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup; an existing settings file remains untouched.
    }
    throw error;
  }
  return normalized;
}
