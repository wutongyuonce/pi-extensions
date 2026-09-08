#!/usr/bin/env node
/**
 * preflight-assets.mjs — check/crawl assets for a domain.
 *
 *   node preflight-assets.mjs --domain <domain> --source <source>
 *
 * Status lines on stdout:
 *   REUSE              — assets already exist and are complete
 *   CRAWLED:N          — crawled N new assets
 *   ERROR:<message>    — something went wrong
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseCli() {
  const args = process.argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
  const domain = get("--domain");
  const source = get("--source") || "teacher";
  if (!domain) {
    console.error("Usage: node preflight-assets.mjs --domain <domain> [--source <source>]");
    process.exit(1);
  }
  return { domain, source };
}

const { domain, source } = parseCli();

// Asset directory convention: <skillRoot>/output/_assets/<domain>/
const skillRoot = path.resolve(__dirname, "..");
const assetsDir = path.join(skillRoot, "output", "_assets", domain);

// Ensure the directory exists
fs.mkdirSync(assetsDir, { recursive: true });

// Check for existing assets
let existing = [];
try {
  existing = fs.readdirSync(assetsDir).filter(f => f !== "." && f !== "..");
} catch {}

// Minimal asset check: look for a manifest or any screenshots/logos
const manifestPath = path.join(assetsDir, "manifest.json");
const hasManifest = fs.existsSync(manifestPath);

if (hasManifest && existing.length > 0) {
  // Assets exist — check if they are minimally complete
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {}

  const hasLogo = manifest.logo || existing.some(f => /logo/i.test(f));
  const hasScreenshots = (manifest.screenshots && manifest.screenshots.length > 0) ||
    existing.some(f => /screenshot|screen|\.(png|jpg|jpeg|webp)/i.test(f));

  if (hasLogo && hasScreenshots) {
    console.log("REUSE");
    process.exit(0);
  }
}

// Try to crawl the domain using the crawl script
const crawlScript = path.join(__dirname, "crawl-website.ts");
if (fs.existsSync(crawlScript)) {
  try {
    // Use npx tsx to run the crawl script
    execSync(
      `npx tsx "${crawlScript}" --domain ${domain} --output "${assetsDir}" 2>&1`,
      { timeout: 60000, encoding: "utf-8" }
    );
    // Count new assets
    const after = fs.readdirSync(assetsDir).filter(f => f !== "." && f !== "..");
    const newCount = after.length - existing.length;
    console.log(`CRAWLED:${Math.max(0, newCount)}`);
  } catch (err) {
    console.log(`ERROR:crawl failed: ${err.message}`);
  }
} else {
  // No crawl script — create a minimal manifest and note the gap
  const minimalManifest = {
    domain,
    source,
    createdAt: new Date().toISOString(),
    assets: existing,
    note: "No crawl-website.ts available — assets must be provided manually or via Playwright MCP",
  };
  fs.writeFileSync(manifestPath, JSON.stringify(minimalManifest, null, 2));
  console.log(`CRAWLED:0`);
}
