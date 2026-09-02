import { describe, expect, it } from "vitest";
import { sortTasks, type TaskSortOrder } from "../src/task-sort.js";
import type { Task, TaskStatus } from "../src/types.js";

function task(id: string, status: TaskStatus = "pending", updatedAt = Number(id)): Task {
  return {
    id,
    subject: `Task ${id}`,
    description: "Desc",
    status,
    metadata: {},
    blocks: [],
    blockedBy: [],
    createdAt: Number(id),
    updatedAt,
  };
}

/** The comparators this module replaced, kept verbatim as the equivalence oracle. */
const ORIGINAL = {
  id: (a: Task, b: Task) => Number(a.id) - Number(b.id),
  status: (a: Task, b: Task) => {
    const rank = (s: string) => s === "completed" ? 0 : s === "in_progress" ? 1 : 2;
    return rank(a.status) - rank(b.status) || Number(a.id) - Number(b.id);
  },
  recent: (a: Task, b: Task) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id),
  oldest: (a: Task, b: Task) => a.updatedAt - b.updatedAt || Number(a.id) - Number(b.id),
};

/** Every status/timestamp combination, including ties on updatedAt so that the
 *  secondary id key is actually exercised in both directions. */
const SAMPLE: Task[] = [
  task("1", "pending", 30),
  task("2", "completed", 10),
  task("3", "in_progress", 30),
  task("4", "completed", 20),
  task("5", "pending", 10),
  task("6", "in_progress", 20),
];

const ids = (tasks: Task[]) => tasks.map(t => t.id);

describe("sortTasks presets", () => {
  it.each(["id", "status", "recent", "oldest"] as const)("'%s' matches the original comparator", order => {
    expect(ids(sortTasks(SAMPLE, order))).toEqual(ids([...SAMPLE].sort(ORIGINAL[order])));
  });

  it("'status' keeps completed first with ids ascending inside each group", () => {
    expect(ids(sortTasks(SAMPLE, "status"))).toEqual(["2", "4", "3", "6", "1", "5"]);
  });

  it("'active' puts in-progress first, then pending, then completed", () => {
    expect(ids(sortTasks(SAMPLE, "active"))).toEqual(["3", "6", "1", "5", "2", "4"]);
  });

  it("'recent' breaks updatedAt ties by descending id", () => {
    expect(ids(sortTasks(SAMPLE, "recent"))).toEqual(["3", "1", "6", "4", "5", "2"]);
  });

  it("defaults to id order", () => {
    expect(ids(sortTasks(SAMPLE))).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("returns a copy without mutating the input", () => {
    const input = [task("3"), task("1"), task("2")];
    expect(ids(sortTasks(input, "id"))).toEqual(["1", "2", "3"]);
    expect(ids(input)).toEqual(["3", "1", "2"]);
  });
});

describe("sortTasks custom specs", () => {
  it("applies a custom status rank with an id tie-break", () => {
    const spec: TaskSortOrder = [
      { field: "status", rank: ["in_progress", "pending", "completed"] },
      { field: "id" },
    ];
    expect(ids(sortTasks(SAMPLE, spec))).toEqual(["3", "6", "1", "5", "2", "4"]);
  });

  it("sorts statuses left out of the rank last, tied among themselves", () => {
    const spec: TaskSortOrder = [{ field: "status", rank: ["pending"] }, { field: "id" }];
    // pending first, then the unranked completed/in_progress in id order.
    expect(ids(sortTasks(SAMPLE, spec))).toEqual(["1", "5", "2", "3", "4", "6"]);
  });

  it("reverses a single key with direction 'desc'", () => {
    expect(ids(sortTasks(SAMPLE, [{ field: "id", direction: "desc" }]))).toEqual(["6", "5", "4", "3", "2", "1"]);
  });

  it("reverses the status rank when the status key is descending", () => {
    const spec: TaskSortOrder = [
      { field: "status", rank: ["completed", "in_progress", "pending"], direction: "desc" },
      { field: "id" },
    ];
    expect(ids(sortTasks(SAMPLE, spec))).toEqual(["1", "5", "3", "6", "2", "4"]);
  });

  it("falls through to later keys only on a tie", () => {
    const spec: TaskSortOrder = [{ field: "updatedAt" }, { field: "id", direction: "desc" }];
    expect(ids(sortTasks(SAMPLE, spec))).toEqual(["5", "2", "6", "4", "3", "1"]);
  });

  it("defaults an omitted rank to the 'status' preset order", () => {
    expect(ids(sortTasks(SAMPLE, [{ field: "status" }, { field: "id" }])))
      .toEqual(ids(sortTasks(SAMPLE, "status")));
  });
});

describe("sortTasks rejects malformed orders", () => {
  const byId = ids(sortTasks(SAMPLE, "id"));

  it.each([
    ["an unknown preset name", "newest"],
    ["a non-array object", { by: [{ field: "id" }] }],
    ["an empty spec", []],
    ["an unknown field", [{ field: "subject" }]],
    ["a bad direction", [{ field: "id", direction: "ascending" }]],
    ["a non-array rank", [{ field: "status", rank: "completed" }]],
    ["an invalid rank entry", [{ field: "status", rank: ["completed", "done"] }]],
    ["a non-object key", [["id"]]],
    ["a prototype property name", "toString"],
    ["null", null],
  ])("falls back to id order for %s", (_label, order) => {
    expect(ids(sortTasks(SAMPLE, order as TaskSortOrder))).toEqual(byId);
  });

  it("rejects a spec if any key is invalid", () => {
    const spec = [{ field: "status" }, { field: "nope" }] as unknown as TaskSortOrder;
    expect(ids(sortTasks(SAMPLE, spec))).toEqual(byId);
  });
});
