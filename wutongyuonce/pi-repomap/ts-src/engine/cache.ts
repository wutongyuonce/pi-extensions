import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { symbolFromJSON, symbolToJSON, type Symbol } from "../models.js";
import { normalizeScope } from "./discover.js";
import { gitHead } from "./git.js";

interface CachePayload {
  version: number;
  signature: string;
  scope: string;
  max_files: number;
  symbols: Record<string, Record<string, unknown>[]>;
}

export async function cacheDir(repoPath: string): Promise<string> {
  const gitDir = path.join(repoPath, ".git");
  try {
    const gitStat = await stat(gitDir);
    if (gitStat.isDirectory()) {
      return gitDir;
    }
  } catch {
    // Fallback below.
  }

  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const fallback = path.join(base, "repo-baby");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

export async function cacheFile(repoPath: string): Promise<string> {
  return path.join(await cacheDir(repoPath), "scope-cache-v2.json");
}

export async function filesSignature(repoPath: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await gitHead(repoPath));

  for (const relPath of files) {
    const fullPath = path.join(repoPath, relPath);
    try {
      const fileStat = await stat(fullPath);
      hash.update(relPath);
      hash.update(String(fileStat.mtimeNs));
      hash.update(String(fileStat.size));
    } catch {
      // Ignore missing files.
    }
  }

  return hash.digest("hex");
}

export async function loadCachedSymbols(
  repoPath: string,
  files: string[],
  scope: string,
  maxFiles: number,
): Promise<Record<string, Symbol[]> | null> {
  try {
    const filePath = await cacheFile(repoPath);
    const payload = JSON.parse(await readFile(filePath, "utf8")) as Partial<CachePayload>;
    if ((payload.signature ?? "") !== await filesSignature(repoPath, files)) {
      return null;
    }
    if ((payload.scope ?? "") !== normalizeScope(scope) || payload.max_files !== maxFiles) {
      return null;
    }
    return symbolsFromJSON(payload.symbols ?? {});
  } catch {
    return null;
  }
}

export async function saveCachedSymbols(
  repoPath: string,
  files: string[],
  scope: string,
  maxFiles: number,
  allSymbols: Record<string, Symbol[]>,
): Promise<void> {
  const payload: CachePayload = {
    version: 2,
    signature: await filesSignature(repoPath, files),
    scope: normalizeScope(scope),
    max_files: maxFiles,
    symbols: symbolsToJSON(allSymbols),
  };

  try {
    const filePath = await cacheFile(repoPath);
    await writeFile(filePath, JSON.stringify(payload), "utf8");
  } catch {
    // Ignore cache failures.
  }
}

function symbolsToJSON(allSymbols: Record<string, Symbol[]>): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(
    Object.entries(allSymbols).map(([filePath, symbols]) => [filePath, symbols.map((symbol) => symbolToJSON(symbol))]),
  );
}

function symbolsFromJSON(data: Record<string, Record<string, unknown>[]>): Record<string, Symbol[]> {
  return Object.fromEntries(
    Object.entries(data).map(([filePath, symbols]) => [filePath, symbols.map((symbol) => symbolFromJSON(symbol))]),
  );
}
