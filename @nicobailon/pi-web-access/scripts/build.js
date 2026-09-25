#!/usr/bin/env node
// Builds the dist/ bundle with externals derived from package.json.
//
// Declared dependencies and peerDependencies stay external: they resolve from
// node_modules at runtime, and the running pi host provides @earendil-works/*
// as jiti virtual modules. Deriving the list keeps future dependencies
// external automatically instead of silently bundling them into dist.
// node:* builtins are covered by --platform=node.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const externals = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  "@earendil-works/*",
];

const esbuildCmd = process.platform === "win32" ? "esbuild.cmd" : "esbuild";
const args = [
  "index.ts",
  "--bundle",
  "--format=esm",
  "--platform=node",
  "--target=node20",
  "--outdir=dist",
  "--outbase=.",
  ...externals.map((name) => `--external:${name}`),
];

const result = spawnSync(esbuildCmd, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
