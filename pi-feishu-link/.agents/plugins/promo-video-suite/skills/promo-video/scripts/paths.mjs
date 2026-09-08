#!/usr/bin/env node
/**
 * paths.mjs — resolve all project paths for a domain/source combo.
 *
 *   node paths.mjs --json --domain <domain> --source <source>
 *
 * Output: JSON on stdout (only JSON when --json is passed).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseCli() {
  const args = process.argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
  const domain = get("--domain");
  const source = get("--source") || "teacher";
  const json = args.includes("--json");
  if (!domain) {
    console.error("Usage: node paths.mjs --json --domain <domain> [--source <source>]");
    process.exit(1);
  }
  return { domain, source, json };
}

const { domain, source, json } = parseCli();

// The skill root is two levels above scripts/
const skillRoot = path.resolve(__dirname, "..");

// Output convention: promo-video/output/<domain>/<source>/
const outputRoot = path.resolve(skillRoot, "output");
const domainOutputDir = path.join(outputRoot, domain, source);

const paths = {
  scriptsDir: __dirname,
  assetsDir: path.join(outputRoot, "_assets", domain),
  artifactDir: path.join(domainOutputDir, "_contracts"),
  projectDir: path.join(domainOutputDir, "remotion-project"),
  outputDir: path.join(domainOutputDir, "delivery"),
};

if (json) {
  console.log(JSON.stringify(paths, null, 2));
} else {
  for (const [k, v] of Object.entries(paths)) {
    console.log(`${k}=${v}`);
  }
}
