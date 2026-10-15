import path from "node:path";

import { describe, expect, it } from "vitest";

import { compareAllFixtures, listFixtureRepos } from "../ts-src/compat/compare.js";

describe("python/typescript compatibility", () => {
  it("matches outputs on all fixture repositories", async () => {
    const projectRoot = path.resolve(path.join(import.meta.dirname, ".."));
    const fixtures = await listFixtureRepos(projectRoot);
    const results = await compareAllFixtures(projectRoot);

    expect(results).toHaveLength(fixtures.length);
    results.forEach((result) => {
      expect(result.ok).toBe(true);
      expect(result.checkedModes).toEqual(["pairs", "overview", "map"]);
    });
  });
});
