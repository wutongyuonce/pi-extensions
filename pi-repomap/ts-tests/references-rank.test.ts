import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSymbol } from "../ts-src/models.js";
import { computeImportance, suggestedReads } from "../ts-src/engine/rank.js";
import { dependencyGraph, extractImports, resolveInternalImport } from "../ts-src/engine/references.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scope-ts-"));
  tempDirs.push(dir);
  return dir;
}

describe("references and rank", () => {
  it("extracts imports from python and js files", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "main.py"), "import os\nfrom pathlib import Path\n", "utf8");
    await writeFile(path.join(repo, "app.js"), 'const fs = require("fs")\nimport { join } from "path"\n', "utf8");

    await expect(extractImports(repo, "main.py")).resolves.toEqual(["os", "pathlib"]);
    await expect(extractImports(repo, "app.js")).resolves.toEqual(["fs", "path"]);
  });

  it("resolves internal imports and builds dependency graph", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "src", "utils"), { recursive: true });
    await writeFile(path.join(repo, "src", "main.py"), "from utils.helper import foo\n", "utf8");
    await writeFile(path.join(repo, "src", "utils", "helper.py"), "def foo():\n    return 1\n", "utf8");

    const files = ["src/main.py", "src/utils/helper.py"];
    expect(resolveInternalImport("utils.helper", "src/main.py", files)).toBe("src/utils/helper.py");

    const graph = await dependencyGraph(repo, files);
    expect(graph.internalCounts["src/utils/helper.py"]).toBe(1);
  });

  it("computes importance and suggested reads", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "a.py"), "def foo():\n    return 1\n", "utf8");
    await writeFile(path.join(repo, "b.py"), "foo()\n", "utf8");

    const symbols = {
      "a.py": [createSymbol({ name: "foo", kind: "function", file: "a.py", line: 1 })],
      "b.py": [],
    };

    await computeImportance(symbols, repo, {});
    expect(symbols["a.py"][0]?.refCount).toBe(1);
    expect(symbols["a.py"][0]?.importance).toBeGreaterThan(0);
    expect(suggestedReads(symbols, ["a.py", "b.py"])).toEqual(["a.py", "b.py"]);
  });
});
