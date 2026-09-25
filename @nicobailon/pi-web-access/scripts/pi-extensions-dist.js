#!/usr/bin/env node
// Switches pi.extensions in package.json to the entry given as argv[2].
//
// Used by the publish lifecycle so published installs load the precompiled
// bundle while development keeps jiti live-transpiling TypeScript:
//   prepublishOnly -> node scripts/pi-extensions-dist.js dist
//   postpublish    -> node scripts/pi-extensions-dist.js index.ts
//
// npm applies publishConfig only to a known field set (registry, access,
// tag, ...), so the nested pi.extensions switch is done by rewriting the
// manifest before the tarball is packed. If a publish is interrupted between
// prepublishOnly and postpublish, package.json is left pointing at ./dist;
// `git checkout -- package.json` restores it.
import { readFileSync, writeFileSync } from "node:fs";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/pi-extensions-dist.js <entry>");
  process.exit(1);
}

const manifestPath = "package.json"; // npm lifecycle scripts run at package root
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!pkg.pi || !Array.isArray(pkg.pi.extensions)) {
  console.error("package.json has no pi.extensions array");
  process.exit(1);
}

pkg.pi.extensions = [entry.startsWith("./") ? entry : `./${entry}`];
writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`pi.extensions -> ${pkg.pi.extensions[0]}`);
