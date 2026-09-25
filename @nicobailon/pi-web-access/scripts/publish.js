#!/usr/bin/env node
// npm skips postpublish after a failed or interrupted publish, so use this
// wrapper to restore pi.extensions. Direct `npm publish` still relies on
// postpublish. SIGKILL cannot be handled and may leave the manifest on ./dist.
//
// Usage: npm run release [-- <npm publish args>]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = "package.json";
const RESTORED_ENTRY = "./index.ts";

function restore() {
  try {
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (pkg.pi && Array.isArray(pkg.pi.extensions) && pkg.pi.extensions[0] !== RESTORED_ENTRY) {
      pkg.pi.extensions = [RESTORED_ENTRY];
      writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
      console.log(`pi.extensions restored -> ${RESTORED_ENTRY}`);
    }
  } catch (error) {
    console.error(`could not restore pi.extensions: ${error.message}`);
  }
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmCmd, ["publish", ...process.argv.slice(2)], { stdio: "inherit" });
let requestedExitCode;

function forwardSignal(signal, exitCode) {
  if (requestedExitCode !== undefined) return;
  requestedExitCode = exitCode;

  // Wait for close before restoring so npm cannot rewrite afterward.
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  else process.exitCode = exitCode;
}

process.on("SIGINT", () => forwardSignal("SIGINT", 130));
process.on("SIGTERM", () => forwardSignal("SIGTERM", 143));

child.on("error", (error) => {
  console.error(`could not start npm publish: ${error.message}`);
});

child.on("close", (status) => {
  restore();
  process.exitCode = requestedExitCode ?? (status !== null && status >= 0 ? status : 1);
});
