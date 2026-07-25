#!/usr/bin/env node

import { Command } from "commander";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadCachedSymbols, saveCachedSymbols } from "./engine/cache.js";
import {
  discoverFiles,
  languageStats,
  pairTests,
  prioritizeFiles,
} from "./engine/discover.js";
import { detectFrameworks } from "./engine/frameworks.js";
import { computeImportance, suggestedReads } from "./engine/rank.js";
import { dependencyGraph } from "./engine/references.js";
import { extractSymbols, isAvailable as parserAvailable } from "./engine/symbols.js";
import type { StatsData, Symbol } from "./models.js";
import { symbolToJSON } from "./models.js";
import { renderMap, renderSuggestions } from "./modes/map.js";
import { renderOverview } from "./modes/overview.js";
import { renderPairs } from "./modes/pairs.js";

const MAX_FILES_DEFAULT = 1000;

interface CliOptions {
  path: string;
  scope: string;
  tokenBudget: number;
  mode: "map" | "overview" | "pairs";
  format: "text" | "json";
  maxFiles: number;
  noCache: boolean;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("scope-ts")
    .description("Scope TypeScript port - codebase orientation tool")
    .requiredOption("--path <dir>", "Path to repository root")
    .option("--scope <dir>", "Limit to a subdirectory", ".")
    .option("--token-budget <n>", "Approximate token budget", parseInteger, 800)
    .option("--mode <mode>", "Output mode", "map")
    .option("--format <format>", "Output format", "text")
    .option("--max-files <n>", "Maximum source files to scan", parseInteger, MAX_FILES_DEFAULT)
    .option("--no-cache", "Disable symbol cache", false);

  program.parse(argv);
  const options = program.opts<CliOptions>();
  const repoPath = path.resolve(options.path);

  try {
    await access(repoPath, constants.R_OK);
  } catch {
    console.error(`Error: ${repoPath} is not readable`);
    process.exitCode = 1;
    return;
  }

  const candidates = prioritizeFiles(await discoverFiles(repoPath, options.scope));
  if (candidates.length === 0) {
    output(options.format, "No source files found", {});
    return;
  }

  const files = candidates.slice(0, Math.max(1, options.maxFiles));
  const stats: StatsData = {
    sourceCandidates: candidates.length,
    scannedFiles: files.length,
    truncated: candidates.length > files.length,
    filesWithSymbols: 0,
    symbols: 0,
    languages: languageStats(files),
    cacheHit: false,
  };

  if (options.mode === "pairs") {
    const pairs = pairTests(files);
    output(options.format, renderPairs(pairs, options.tokenBudget), {
      mode: "pairs",
      pairs,
      stats,
    });
    return;
  }

  const needsSymbols = options.mode === "map" || options.mode === "overview";
  let allSymbols: Record<string, Symbol[]> = {};
  let cacheHit = false;

  if (needsSymbols && parserAvailable()) {
    if (!options.noCache) {
      const cached = await loadCachedSymbols(repoPath, files, options.scope, Math.max(1, options.maxFiles));
      if (cached) {
        allSymbols = cached;
        cacheHit = true;
      }
    }

    if (Object.keys(allSymbols).length === 0) {
      for (const relPath of files) {
        const symbols = await extractSymbols(relPath, repoPath);
        if (symbols.length > 0) {
          allSymbols[relPath] = symbols;
        }
      }
      if (!options.noCache) {
        await saveCachedSymbols(repoPath, files, options.scope, Math.max(1, options.maxFiles), allSymbols);
      }
    }
  }

  const graph = Object.keys(allSymbols).length > 0
    ? await dependencyGraph(repoPath, files)
    : { internalCounts: {}, externalCounts: {} };

  if (Object.keys(allSymbols).length > 0) {
    await computeImportance(allSymbols, repoPath, graph.internalCounts);
  }

  stats.filesWithSymbols = Object.keys(allSymbols).length;
  stats.symbols = Object.values(allSymbols).reduce((sum, symbols) => sum + symbols.length, 0);
  stats.cacheHit = cacheHit;

  const frameworks = await detectFrameworks(repoPath, files);
  const reads = suggestedReads(allSymbols, files);

  let text = "";
  let data: Record<string, unknown> = {
    mode: options.mode,
    stats,
    frameworks,
    suggestedReads: reads,
  };

  if (options.mode === "map") {
    text = renderMap(allSymbols, options.tokenBudget);
    const suggestions = renderSuggestions(reads);
    if (suggestions) {
      text += suggestions;
    }
    data = {
      ...data,
      symbols: Object.fromEntries(
        Object.entries(allSymbols).map(([filePath, symbols]) => [filePath, symbols.map((symbol) => symbolToJSON(symbol))]),
      ),
    };
  } else if (options.mode === "overview") {
    text = renderOverview({ stats, frameworks, suggestedReads: reads });
  }

  if (needsSymbols && !parserAvailable()) {
    text = "# Tree-sitter dependencies missing\nInstall with: npm install";
    data.error = "Tree-sitter dependencies missing";
  } else if (needsSymbols && Object.keys(allSymbols).length === 0 && parserAvailable()) {
    text = "# No symbols found\n\nTry narrowing --scope or use --mode pairs for test mapping.";
    data.warning = "No symbols found";
  }

  output(options.format, text, data);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function output(format: "text" | "json", text: string, data: Record<string, unknown>): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(text);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
