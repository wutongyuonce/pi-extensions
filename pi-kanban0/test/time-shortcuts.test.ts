import { describe, expect, it } from "vitest";
import { cardTimeShortcuts } from "../src/time-shortcuts.js";

describe("card time shortcuts", () => {
  it("offers Today first, followed by Now, Tomorrow, and custom input", () => {
    const current = new Date(2026, 7, 4, 9, 5);

    expect(cardTimeShortcuts(current)).toEqual([
      { label: "Today · 2026-08-04", value: "2026-08-04" },
      { label: "Now · 2026-08-04 09:05", value: "2026-08-04 09:05" },
      { label: "Tomorrow · 2026-08-05", value: "2026-08-05" },
      { label: "Custom time…" },
    ]);
  });

  it("computes Tomorrow with local calendar arithmetic across year boundaries", () => {
    const current = new Date(2026, 11, 31, 23, 59);

    expect(cardTimeShortcuts(current)[2]).toEqual({
      label: "Tomorrow · 2027-01-01",
      value: "2027-01-01",
    });
  });
});
