#!/usr/bin/env node

import path from "node:path";

import { compareAllFixtures, comparePythonAndTypeScript, defaultFixturePath } from "../compat/compare.js";

async function main(): Promise<void> {
  const projectRoot = path.resolve(path.join(import.meta.dirname, "..", ".."));
  if (process.argv[2]) {
    const repoPath = path.resolve(process.argv[2]);
    const result = await comparePythonAndTypeScript(repoPath, projectRoot);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const defaultPath = defaultFixturePath(projectRoot);
  const results = await compareAllFixtures(projectRoot);
  console.log(
    JSON.stringify(
      {
        ok: true,
        defaultPath,
        fixtures: results,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
