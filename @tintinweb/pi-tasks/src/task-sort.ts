/**
 * task-sort.ts — Task ordering for the widget.
 *
 * `sortOrder` is either a built-in preset name or a sort spec: an ordered list of
 * comparison keys. Specs are pure data — there is deliberately no executable config
 * file, because `.pi/` lives inside cloned repositories.
 */

import type { Task, TaskStatus } from "./types.js";

export type SortField = "id" | "status" | "updatedAt";
export type SortDirection = "asc" | "desc";

export interface SortKey {
  field: SortField;
  /** Default "asc". Reverses this key only, status rank included. */
  direction?: SortDirection;
  /** `status` only. Statuses left out of the rank sort last and tie. */
  rank?: TaskStatus[];
}

export type SortSpec = SortKey[];
export type BuiltInSortOrder = "id" | "status" | "active" | "recent" | "oldest";
export type TaskSortOrder = BuiltInSortOrder | SortSpec;

const SORT_FIELDS: SortField[] = ["id", "status", "updatedAt"];
const STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];

/** Also used when a status key omits `rank`. */
const DEFAULT_STATUS_RANK: TaskStatus[] = ["completed", "in_progress", "pending"];

/** Built-in presets, expressed as specs. All but `active` reproduce the original
 *  comparators exactly, tie-breaks included. */
const PRESETS: Record<BuiltInSortOrder, SortSpec> = {
  id: [{ field: "id" }],
  status: [{ field: "status", rank: DEFAULT_STATUS_RANK }, { field: "id" }],
  active: [{ field: "status", rank: ["in_progress", "pending", "completed"] }, { field: "id" }],
  recent: [{ field: "updatedAt", direction: "desc" }, { field: "id", direction: "desc" }],
  oldest: [{ field: "updatedAt" }, { field: "id" }],
};

export const BUILT_IN_SORT_ORDERS = Object.keys(PRESETS) as BuiltInSortOrder[];

function isSortKey(value: unknown): value is SortKey {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { field, direction, rank } = value as Record<string, unknown>;
  if (!SORT_FIELDS.includes(field as SortField)) return false;
  if (direction !== undefined && direction !== "asc" && direction !== "desc") return false;
  if (rank !== undefined && (!Array.isArray(rank) || !rank.every(s => STATUSES.includes(s as TaskStatus)))) return false;
  return true;
}

/** Resolve a configured order to a spec. Never throws and never rejects loudly:
 *  config files are hand-edited, and a malformed one must not break the widget. */
function toSpec(order: unknown): SortSpec {
  if (typeof order === "string") {
    // hasOwn, not `in` — "toString" is on the prototype chain.
    return Object.hasOwn(PRESETS, order) ? PRESETS[order as BuiltInSortOrder] : PRESETS.id;
  }
  if (Array.isArray(order) && order.length > 0 && order.every(isSortKey)) return order;
  return PRESETS.id;
}

function statusIndex(status: TaskStatus, rank: TaskStatus[]): number {
  const index = rank.indexOf(status);
  return index === -1 ? rank.length : index;
}

function compareKey(a: Task, b: Task, key: SortKey): number {
  if (key.field === "status") {
    const rank = key.rank ?? DEFAULT_STATUS_RANK;
    return statusIndex(a.status, rank) - statusIndex(b.status, rank);
  }
  return key.field === "id" ? Number(a.id) - Number(b.id) : a.updatedAt - b.updatedAt;
}

function buildComparator(spec: SortSpec): (a: Task, b: Task) => number {
  return (a, b) => {
    for (const key of spec) {
      const delta = compareKey(a, b, key);
      if (delta !== 0) return key.direction === "desc" ? -delta : delta;
    }
    return 0;
  };
}

/** Return a sorted copy, leaving the input untouched. */
export function sortTasks(tasks: readonly Task[], order: TaskSortOrder = "id"): Task[] {
  return [...tasks].sort(buildComparator(toSpec(order)));
}
