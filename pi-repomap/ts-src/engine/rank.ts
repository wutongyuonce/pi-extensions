import type { Symbol } from "../models.js";
import { isTestFile } from "./discover.js";
import { readText } from "./utils.js";

const IDENTIFIER_RE = /[a-zA-Z_]\w+/g;

export function buildSymbolIndex(allSymbols: Record<string, Symbol[]>): Record<string, Symbol[]> {
  const index = new Map<string, Symbol[]>();
  for (const symbols of Object.values(allSymbols)) {
    for (const symbol of symbols) {
      for (const token of referenceTokens(symbol.name)) {
        const entries = index.get(token) ?? [];
        entries.push(symbol);
        index.set(token, entries);
      }
    }
  }
  return Object.fromEntries(index.entries());
}

function referenceTokens(name: string): Set<string> {
  const base = name.includes(".") ? name.split(".").at(-1) ?? name : name;
  const tokens = new Set<string>([base]);
  if (!name.includes(".")) {
    tokens.add(name);
  }
  return new Set([...tokens].filter((token) => /^[a-zA-Z_]\w+$/.test(token)));
}

export async function computeImportance(
  allSymbols: Record<string, Symbol[]>,
  repoPath: string,
  fileInrefs: Record<string, number> = {},
): Promise<void> {
  const index = buildSymbolIndex(allSymbols);
  const tokenSet = new Set(Object.keys(index));
  if (tokenSet.size === 0) {
    return;
  }

  const refCount = new Map<string, number>();
  for (const filePath of Object.keys(allSymbols)) {
    const content = await readText(repoPath, filePath, Number.MAX_SAFE_INTEGER);
    if (!content) {
      continue;
    }

    const wordsInFile = new Set<string>();
    for (const match of content.matchAll(IDENTIFIER_RE)) {
      const token = match[0];
      if (tokenSet.has(token) && !wordsInFile.has(token)) {
        wordsInFile.add(token);
        for (const symbol of index[token] ?? []) {
          if (symbol.file !== filePath) {
            const key = `${symbol.file}::${symbol.name}`;
            refCount.set(key, (refCount.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }

  for (const [filePath, symbols] of Object.entries(allSymbols)) {
    const isTest = isTestFile(filePath);
    for (const symbol of symbols) {
      const key = `${symbol.file}::${symbol.name}`;
      let score = refCount.get(key) ?? 0;
      symbol.refCount = score;

      if (symbol.kind === "class" || symbol.kind === "interface") {
        score *= 1.5;
      } else if (symbol.kind === "resource" || symbol.kind === "module" || symbol.kind === "data") {
        score *= 2.0;
      } else if (symbol.kind === "key") {
        score = -1.0;
      }

      const baseName = symbol.name.includes(".") ? symbol.name.split(".").at(-1) ?? symbol.name : symbol.name;
      if (["main", "index", "App", "Server", "setup", "configure", "create_app", "handler"].includes(baseName)) {
        score += 5.0;
      }

      score += Math.min(fileInrefs[filePath] ?? 0, 25) * 0.35;
      if (isTest || baseName.startsWith("test_") || baseName.startsWith("it(")) {
        score *= 0.05;
      }

      symbol.importance = score;
    }
  }
}

export function suggestedReads(allSymbols: Record<string, Symbol[]>, files: string[], limit = 5): string[] {
  const scored = Object.entries(allSymbols)
    .map(([filePath, symbols]) => ({
      filePath,
      total: symbols.reduce((sum, symbol) => sum + symbol.importance, 0),
    }))
    .sort((left, right) => right.total - left.total || left.filePath.localeCompare(right.filePath));

  if (scored.length === 0) {
    return files.slice(0, limit);
  }

  return scored.slice(0, limit).map((entry) => entry.filePath);
}
