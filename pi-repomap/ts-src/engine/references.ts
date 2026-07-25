import path from "node:path";

import type { DependencyGraph } from "../models.js";
import { SUPPORTED_EXTENSIONS } from "./discover.js";
import { normalizePath, readText } from "./utils.js";

const IMPORT_RE = /(?:from\s+([\w./\-@]+)\s+import|import\s+([\w./\-@]+)|require\(['"]([^'"]+)['"]\)|use\s+([\w:]+))/g;
const FROM_STRING_RE = /\bfrom\s+['"]([^'"]+)['"]/;
const SIDE_EFFECT_IMPORT_RE = /^import\s+['"]([^'"]+)['"]/;

export async function extractImports(repoPath: string, relPath: string): Promise<string[]> {
  const text = await readText(repoPath, relPath);
  if (!text) {
    return [];
  }

  const ext = path.extname(relPath);
  const imports = new Set<string>();
  for (const line of text.split(/\r?\n/).slice(0, 2000)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || stripped.startsWith("//") || stripped.startsWith("*")) {
      continue;
    }

    if (ext === ".js" || ext === ".ts" || ext === ".tsx") {
      const match = stripped.match(FROM_STRING_RE) ?? stripped.match(SIDE_EFFECT_IMPORT_RE);
      if (match?.[1]) {
        imports.add(match[1]);
      }
      const requireMatch = stripped.match(/require\(['"]([^'"]+)['"]\)/);
      if (requireMatch?.[1]) {
        imports.add(requireMatch[1]);
      }
      continue;
    }

    if (ext === ".py" && !(stripped.startsWith("import ") || stripped.startsWith("from "))) {
      continue;
    }
    if (ext === ".rs" && !stripped.startsWith("use ")) {
      continue;
    }
    if (ext === ".go") {
      if (!(stripped.startsWith("import ") || (stripped.startsWith('"') && stripped.endsWith('"')))) {
        continue;
      }
      const goMatch = stripped.match(/^import\s+"([^"]+)"/);
      if (goMatch?.[1]) {
        imports.add(goMatch[1]);
        continue;
      }
      if (stripped.startsWith('"') && stripped.endsWith('"')) {
        imports.add(stripped.slice(1, -1));
        continue;
      }
    }

    for (const match of stripped.matchAll(IMPORT_RE)) {
      const target = match.slice(1).find(Boolean);
      if (target) {
        imports.add(target);
      }
    }
  }

  return [...imports].sort();
}

export function resolveInternalImport(importName: string, importer: string, files: string[]): string | null {
  const fileSet = new Set(files);
  const candidates: string[] = [];

  if (importName.startsWith(".")) {
    const base = path.posix.join(path.posix.dirname(normalizePath(importer)), importName);
    for (const ext of SUPPORTED_EXTENSIONS) {
      candidates.push(normalizePath(path.posix.normalize(`${base}${ext}`)));
    }
    for (const ext of [".ts", ".tsx", ".js"]) {
      candidates.push(normalizePath(path.posix.normalize(path.posix.join(base, `index${ext}`))));
    }
  }

  const dotted = importName.replaceAll(".", "/").replaceAll("::", "/");
  for (const ext of SUPPORTED_EXTENSIONS) {
    candidates.push(`${dotted}${ext}`);
    candidates.push(`src/${dotted}${ext}`);
  }

  for (const candidate of candidates) {
    const normalized = normalizePath(path.posix.normalize(candidate));
    if (fileSet.has(normalized)) {
      return normalized;
    }
  }

  return null;
}

export async function dependencyGraph(repoPath: string, files: string[]): Promise<DependencyGraph> {
  const importedBy = new Map<string, Set<string>>();
  const external = new Map<string, number>();

  for (const relPath of files) {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(relPath))) {
      continue;
    }

    const imports = await extractImports(repoPath, relPath);
    for (const item of imports) {
      const internal = resolveInternalImport(item, relPath, files);
      if (internal) {
        const importers = importedBy.get(internal) ?? new Set<string>();
        importers.add(relPath);
        importedBy.set(internal, importers);
      } else {
        const root = item.split("/", 1)[0]?.split(".", 1)[0]?.split("::", 1)[0] ?? "";
        if (root && !root.startsWith(".")) {
          external.set(root, (external.get(root) ?? 0) + 1);
        }
      }
    }
  }

  const internalCounts = Object.fromEntries(
    [...importedBy.entries()]
      .map(([file, importers]) => [file, importers.size] as const)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
  const externalCounts = Object.fromEntries(
    [...external.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );

  return {
    internalCounts,
    externalCounts,
  };
}
