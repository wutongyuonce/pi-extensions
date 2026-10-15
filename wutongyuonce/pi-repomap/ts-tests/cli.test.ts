import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../ts-src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scope-ts-cli-"));
  tempDirs.push(dir);
  return dir;
}

describe("cli", () => {
  it("renders overview json", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }), "utf8");
    await writeFile(path.join(repo, "src", "main.ts"), "export function main() { return 1; }\n", "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["node", "scope-ts", "--path", repo, "--mode", "overview", "--format", "json"]);

    const output = String(log.mock.calls.at(-1)?.[0] ?? "");
    const payload = JSON.parse(output) as Record<string, unknown>;
    expect(payload.mode).toBe("overview");
    expect((payload.frameworks as { frameworks: string[] }).frameworks).toContain("React");
  });

  it("renders pairs mode text", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "src", "helper.py"), "def helper():\n    return 1\n", "utf8");
    await writeFile(path.join(repo, "tests", "test_helper.py"), "def test_helper():\n    assert True\n", "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["node", "scope-ts", "--path", repo, "--mode", "pairs"]);

    const output = String(log.mock.calls.at(-1)?.[0] ?? "");
    expect(output).toContain("# Test/source pairs");
    expect(output).toContain("src/helper.py");
  });

  it("renders map mode with symbols", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "service.py"), "class User:\n    def login(self):\n        return True\n", "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["node", "scope-ts", "--path", repo, "--mode", "map"]);

    const output = String(log.mock.calls.at(-1)?.[0] ?? "");
    expect(output).toContain("class User");
    expect(output).toContain("method User.login");
  });
});
