import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { chooseBoardLocation, chooseImportLocation } from "../src/index.js";
import {
  ensureGlobalBoard,
  ensureProjectBoard,
  globalBoardPath,
  projectBoardPath,
} from "../src/project-board.js";

const createdDirectories: string[] = [];

function temporaryRoots(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-kanban0-scope-"));
  createdDirectories.push(root);
  return { cwd: join(root, "project"), agentDir: join(root, "agent") };
}

function context(cwd: string, select: (options: string[]) => string | undefined): ExtensionCommandContext {
  return {
    cwd,
    ui: {
      select: async (_title: string, options: string[]) => select(options),
    },
  } as unknown as ExtensionCommandContext;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("board scope selection", () => {
  it("offers project and global creation when neither board exists", async () => {
    const { cwd, agentDir } = temporaryRoots();
    let offered: string[] = [];
    const location = await chooseBoardLocation(context(cwd, (options) => {
      offered = options;
      return options[0];
    }), undefined, agentDir);

    expect(offered).toHaveLength(2);
    expect(offered[0]).toContain("Project board");
    expect(offered[1]).toContain("Global board");
    expect(location).toEqual({ path: projectBoardPath(cwd), created: true, scope: "project" });
  });

  it("opens an existing global board without showing the scope menu", async () => {
    const { cwd, agentDir } = temporaryRoots();
    ensureGlobalBoard(agentDir);
    const location = await chooseBoardLocation(context(cwd, () => {
      throw new Error("scope menu should not open");
    }), undefined, agentDir);

    expect(location).toEqual({ path: globalBoardPath(agentDir), created: false, scope: "global" });
  });

  it("opens an existing project board without showing the scope menu", async () => {
    const { cwd, agentDir } = temporaryRoots();
    ensureProjectBoard(cwd);
    const location = await chooseBoardLocation(context(cwd, () => {
      throw new Error("scope menu should not open");
    }), undefined, agentDir);

    expect(location).toEqual({ path: projectBoardPath(cwd), created: false, scope: "project" });
  });

  it("supports an explicit global scope without a menu", async () => {
    const { cwd, agentDir } = temporaryRoots();
    const location = await chooseBoardLocation(context(cwd, () => {
      throw new Error("scope menu should not open");
    }), "global", agentDir);

    expect(location).toEqual({ path: globalBoardPath(agentDir), created: true, scope: "global" });
  });
});

describe("import scope selection", () => {
  it("asks for a destination when neither board exists", async () => {
    const { cwd, agentDir } = temporaryRoots();
    let offered: string[] = [];
    const location = await chooseImportLocation(context(cwd, (options) => {
      offered = options;
      return options[1];
    }), agentDir);

    expect(offered).toHaveLength(2);
    expect(offered[0]).toContain("Project board");
    expect(offered[1]).toContain("Global board");
    expect(location).toEqual({ path: globalBoardPath(agentDir), created: true, scope: "global" });
  });

  it("uses an existing project board without asking", async () => {
    const { cwd, agentDir } = temporaryRoots();
    ensureProjectBoard(cwd);

    const location = await chooseImportLocation(context(cwd, () => {
      throw new Error("import destination menu should not open");
    }), agentDir);

    expect(location).toEqual({ path: projectBoardPath(cwd), created: false, scope: "project" });
  });

  it("uses an existing global board when the project has none", async () => {
    const { cwd, agentDir } = temporaryRoots();
    ensureGlobalBoard(agentDir);

    const location = await chooseImportLocation(context(cwd, () => {
      throw new Error("import destination menu should not open");
    }), agentDir);

    expect(location).toEqual({ path: globalBoardPath(agentDir), created: false, scope: "global" });
  });

  it("cancels when the destination menu is dismissed", async () => {
    const { cwd, agentDir } = temporaryRoots();
    const location = await chooseImportLocation(context(cwd, () => undefined), agentDir);

    expect(location).toBeUndefined();
  });
});
