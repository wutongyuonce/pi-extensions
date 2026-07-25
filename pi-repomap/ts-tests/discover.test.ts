import { describe, expect, it } from "vitest";

import {
  isConfigOrEntrypoint,
  isTestFile,
  languageStats,
  normalizeScope,
  pairTests,
  prioritizeFiles,
} from "../ts-src/engine/discover.js";

describe("discover", () => {
  it("normalizes scope", () => {
    expect(normalizeScope(".")).toBe(".");
    expect(normalizeScope("")).toBe(".");
    expect(normalizeScope("src")).toBe("src");
    expect(normalizeScope("/src")).toBe("src");
    expect(normalizeScope("src/")).toBe("src");
    expect(normalizeScope("src/api")).toBe("src/api");
  });

  it("detects test files", () => {
    expect(isTestFile("tests/test_foo.py")).toBe(true);
    expect(isTestFile("src/foo/test_bar.py")).toBe(true);
    expect(isTestFile("foo.test.ts")).toBe(true);
    expect(isTestFile("bar.spec.js")).toBe(true);
    expect(isTestFile("test_main.go")).toBe(true);
    expect(isTestFile("foo_test.go")).toBe(true);
    expect(isTestFile("foo/tests/bar.py")).toBe(true);
    expect(isTestFile("/project/tests/test_a.py")).toBe(true);
    expect(isTestFile("src/main.py")).toBe(false);
    expect(isTestFile("src/utils/helper.ts")).toBe(false);
  });

  it("detects config and entrypoint files", () => {
    expect(isConfigOrEntrypoint("package.json")).toBe(true);
    expect(isConfigOrEntrypoint("pyproject.toml")).toBe(true);
    expect(isConfigOrEntrypoint("Makefile")).toBe(true);
    expect(isConfigOrEntrypoint("src/main.py")).toBe(true);
    expect(isConfigOrEntrypoint("app.ts")).toBe(true);
    expect(isConfigOrEntrypoint("Dockerfile")).toBe(true);
    expect(isConfigOrEntrypoint("src/utils/helper.py")).toBe(false);
  });

  it("prioritizes entrypoints ahead of tests", () => {
    const files = [
      "tests/test_main.py",
      "src/main.py",
      "src/utils/helper.py",
      "README.md",
      "node_modules/pkg/index.js",
    ];
    const prioritized = prioritizeFiles(files);
    expect(prioritized.indexOf("src/main.py")).toBeLessThan(prioritized.indexOf("node_modules/pkg/index.js"));
    expect(prioritized[0]).not.toBe("tests/test_main.py");
  });

  it("computes language stats", () => {
    const stats = languageStats(["a.py", "b.py", "c.js", "d.ts", "e.go", "f.rs"]);
    expect(stats.python).toBe(2);
    expect(stats.javascript).toBe(1);
    expect(stats.typescript).toBe(1);
    expect(stats.go).toBe(1);
    expect(stats.rust).toBe(1);
  });

  it("pairs source files with matching tests", () => {
    const pairs = pairTests([
      "src/main.py",
      "src/utils/helper.py",
      "tests/test_main.py",
      "tests/test_helper.py",
    ]);

    expect(pairs["src/main.py"]?.length).toBeGreaterThanOrEqual(1);
    expect(pairs["src/utils/helper.py"]?.length).toBeGreaterThanOrEqual(1);
  });
});
