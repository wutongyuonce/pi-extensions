import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { main as runTypeScriptMain } from "../index.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface CompareResult {
  ok: boolean;
  checkedModes: string[];
  repoPath: string;
}

export async function comparePythonAndTypeScript(repoPath: string, projectRoot: string): Promise<CompareResult> {
  const checkedModes: string[] = [];

  for (const mode of ["pairs", "overview", "map"] as const) {
    const python = normalizeModeOutput(mode, await runPythonScope(projectRoot, repoPath, mode));
    const typescript = normalizeModeOutput(mode, await runTypeScriptScope(projectRoot, repoPath, mode));
    assert.deepStrictEqual(
      typescript,
      python,
      `Mismatch in ${mode} mode\nPython: ${JSON.stringify(python, null, 2)}\nTypeScript: ${JSON.stringify(typescript, null, 2)}`,
    );
    checkedModes.push(mode);
  }

  return {
    ok: true,
    checkedModes,
    repoPath,
  };
}

export async function compareAllFixtures(projectRoot: string): Promise<CompareResult[]> {
  const repos = await listFixtureRepos(projectRoot);
  const results: CompareResult[] = [];
  for (const repoPath of repos) {
    results.push(await comparePythonAndTypeScript(repoPath, projectRoot));
  }
  return results;
}

async function runPythonScope(projectRoot: string, repoPath: string, mode: "pairs" | "overview" | "map"): Promise<Record<string, JsonValue>> {
  const result = await execa(
    "uv",
    ["run", "python", "-m", "scope", "--path", repoPath, "--mode", mode, "--format", "json", "--no-cache"],
    { cwd: projectRoot },
  );
  return JSON.parse(result.stdout) as Record<string, JsonValue>;
}

async function runTypeScriptScope(projectRoot: string, repoPath: string, mode: "pairs" | "overview" | "map"): Promise<Record<string, JsonValue>> {
  const originalCwd = process.cwd();
  const logs: string[] = [];
  const spy = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };

  try {
    process.chdir(projectRoot);
    await runTypeScriptMain(["node", "scope-ts", "--path", repoPath, "--mode", mode, "--format", "json", "--no-cache"]);
  } finally {
    console.log = spy;
    process.chdir(originalCwd);
  }

  return JSON.parse(logs.at(-1) ?? "{}") as Record<string, JsonValue>;
}

function normalizeModeOutput(mode: "pairs" | "overview" | "map", payload: Record<string, JsonValue>): JsonValue {
  if (mode === "pairs") {
    return {
      mode: String(payload.mode),
      pairs: normalizePairs(payload.pairs),
    };
  }

  if (mode === "overview") {
    return {
      mode: String(payload.mode),
      frameworks: normalizeFrameworks(payload.frameworks),
      suggestedReads: normalizeStringList(payload.suggested_reads ?? payload.suggestedReads),
      stats: normalizeStats(payload.stats),
    };
  }

  return {
    mode: String(payload.mode),
    frameworks: normalizeFrameworks(payload.frameworks),
    suggestedReads: normalizeStringList(payload.suggested_reads ?? payload.suggestedReads),
    symbols: normalizeSymbols(payload.symbols),
    stats: normalizeStats(payload.stats),
  };
}

function normalizePairs(value: JsonValue | undefined): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(asRecord(value))
      .map(([filePath, tests]) => [filePath, normalizeStringList(tests)] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function normalizeFrameworks(value: JsonValue | undefined): Record<string, JsonValue> {
  const record = asRecord(value);
  return {
    frameworks: normalizeStringList(record.frameworks),
    entrypoints: normalizeStringList(record.entrypoints),
    packageScripts: Object.fromEntries(
      Object.entries(asRecord(record.package_scripts ?? record.packageScripts)).sort((left, right) => left[0].localeCompare(right[0])),
    ),
  };
}

function normalizeStats(value: JsonValue | undefined): Record<string, JsonValue> {
  const record = asRecord(value);
  const languages = Object.fromEntries(
    Object.entries(asRecord(record.languages)).sort((left, right) => left[0].localeCompare(right[0])),
  );
  return {
    sourceCandidates: Number(record.source_candidates ?? record.sourceCandidates ?? 0),
    scannedFiles: Number(record.scanned_files ?? record.scannedFiles ?? 0),
    truncated: Boolean(record.truncated ?? false),
    filesWithSymbols: Number(record.files_with_symbols ?? record.filesWithSymbols ?? 0),
    symbols: Number(record.symbols ?? 0),
    languages,
  };
}

function normalizeSymbols(value: JsonValue | undefined): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(asRecord(value))
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([filePath, symbols]) => [
        filePath,
        asArray(symbols)
          .map((symbol) => normalizeSymbol(asRecord(symbol)))
          .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name) || left.line - right.line),
      ]),
  );
}

function normalizeSymbol(symbol: Record<string, JsonValue>): { kind: string; line: number; name: string; refCount: number } {
  return {
    kind: String(symbol.kind),
    name: String(symbol.name),
    line: Number(symbol.line ?? 0),
    refCount: Number(symbol.ref_count ?? symbol.refCount ?? 0),
  };
}

function normalizeStringList(value: JsonValue | undefined): string[] {
  return asArray(value).map((item) => String(item)).sort((left, right) => left.localeCompare(right));
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

export function fixtureRoot(projectRoot: string): string {
  return path.join(projectRoot, "ts-tests", "fixtures");
}

export function defaultFixturePath(projectRoot: string): string {
  return path.join(fixtureRoot(projectRoot), "mini-python-repo");
}

export async function listFixtureRepos(projectRoot: string): Promise<string[]> {
  const root = fixtureRoot(projectRoot);
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));
}
