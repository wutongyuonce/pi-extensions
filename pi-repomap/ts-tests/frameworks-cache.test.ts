import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveCachedSymbols, loadCachedSymbols } from "../ts-src/engine/cache.js";
import { detectFrameworks } from "../ts-src/engine/frameworks.js";
import { createSymbol } from "../ts-src/models.js";

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

describe("frameworks and cache", () => {
  it("detects frameworks and package scripts", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.0.0", vite: "^5.0.0" },
        scripts: { dev: "vite", build: "vite build" },
      }),
      "utf8",
    );
    await writeFile(path.join(repo, "pyproject.toml"), '[project]\ndependencies = ["fastapi", "pytest"]\n', "utf8");
    await writeFile(path.join(repo, "src", "main.ts"), "export {};\n", "utf8");

    const result = await detectFrameworks(repo, ["package.json", "pyproject.toml", "src/main.ts"]);
    expect(result.frameworks).toContain("React");
    expect(result.frameworks).toContain("Vite");
    expect(result.frameworks).toContain("FastAPI");
    expect(result.packageScripts.dev).toBe("vite");
    expect(result.entrypoints).toContain("src/main.ts");
  });

  it("round-trips cached symbols", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await writeFile(path.join(repo, "a.py"), "def foo():\n    return 1\n", "utf8");

    const symbols = {
      "a.py": [createSymbol({ name: "foo", kind: "function", file: "a.py", line: 1, importance: 3, refCount: 2 })],
    };

    await saveCachedSymbols(repo, ["a.py"], ".", 1000, symbols);
    const payload = JSON.parse(await readFile(path.join(repo, ".git", "scope-cache-v2.json"), "utf8")) as Record<string, unknown>;
    expect(payload.version).toBe(2);

    const restored = await loadCachedSymbols(repo, ["a.py"], ".", 1000);
    expect(restored?.["a.py"]?.[0]?.name).toBe("foo");
    expect(restored?.["a.py"]?.[0]?.refCount).toBe(2);
  });
});
