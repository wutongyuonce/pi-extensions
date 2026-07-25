import { type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { normalizePath } from "./utils.js";

export const IGNORE_DIRS = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  "target",
  ".terraform",
  ".idea",
  ".vscode",
  "vendor",
  "bin",
  "obj",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  "htmlcov",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".hypothesis",
  ".hg",
  ".svn",
  "site-packages",
]);

export const SUPPORTED_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  ".cs",
  ".php",
  ".kt",
  ".kts",
  ".swift",
  ".scala",
  ".sc",
  ".sh",
  ".bash",
  ".sql",
  ".lua",
  ".tf",
  ".tfvars",
  ".hcl",
]);

export const ENTRYPOINT_NAMES = new Set([
  "main",
  "index",
  "app",
  "server",
  "cli",
  "cmd",
  "handler",
  "manage",
  "wsgi",
  "asgi",
  "router",
  "routes",
]);

export const CONFIG_FILENAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "composer.json",
  "Gemfile",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "terraform.tf",
  "main.tf",
  "variables.tf",
  "outputs.tf",
]);

export const TEST_MARKERS = ["/test/", "/tests/", "/__tests__/", ".test.", ".spec."] as const;

const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /\.min\.(js|css)$/i,
  /go\.sum$/i,
  /Gemfile\.lock$/,
  /poetry\.lock$/,
  /uv\.lock$/,
  /\.d\.ts$/,
];

const EXT_TO_LANG: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".sc": "scala",
  ".sh": "bash",
  ".bash": "bash",
  ".sql": "sql",
  ".lua": "lua",
  ".tf": "hcl",
  ".tfvars": "hcl",
  ".hcl": "hcl",
};

export function normalizeScope(scope: string): string {
  const trimmed = (scope || ".").trim().replaceAll("\\", "/");
  if (trimmed === "" || trimmed === ".") {
    return ".";
  }

  const withoutPrefix = trimmed.replace(/^\/+/, "");
  const normalized = normalizePath(path.posix.normalize(withoutPrefix));
  if (normalized === "." || normalized.startsWith("..")) {
    return ".";
  }

  return normalized.replace(/\/+$/, "");
}

export async function gitTrackedFiles(repoPath: string): Promise<string[]> {
  try {
    const result = await execa("git", ["ls-files"], {
      cwd: repoPath,
      timeout: 10_000,
    });
    return result.stdout
      .split("\n")
      .map((file: string) => file.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function walkFiles(repoPath: string, scope = "."): Promise<string[]> {
  const files: string[] = [];
  const normalizedScope = normalizeScope(scope);
  const scopePath = path.join(repoPath, normalizedScope);

  async function visit(dirPath: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      const relPath = normalizePath(path.relative(repoPath, fullPath));

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          await visit(fullPath);
        }
        continue;
      }

      if (shouldIncludeFile(relPath)) {
        files.push(relPath);
      }
    }
  }

  await visit(scopePath);
  return files;
}

export async function discoverFiles(repoPath: string, scope = "."): Promise<string[]> {
  const normalizedScope = normalizeScope(scope);
  const tracked = await gitTrackedFiles(repoPath);
  if (tracked.length > 0) {
    const prefix = normalizedScope === "." ? "" : `${normalizedScope.replace(/\/$/, "")}/`;
    return tracked.filter((file) => {
      if (prefix && !(file === normalizedScope || file.startsWith(prefix))) {
        return false;
      }
      return shouldIncludeFile(file);
    });
  }

  return walkFiles(repoPath, normalizedScope);
}

export function shouldIncludeFile(relPath: string): boolean {
  const base = path.basename(relPath);
  const ext = path.extname(relPath);

  if (SKIP_FILE_PATTERNS.some((pattern) => pattern.test(relPath))) {
    return false;
  }

  if (CONFIG_FILENAMES.has(base) || base.toLowerCase().startsWith("readme.")) {
    return true;
  }

  return SUPPORTED_EXTENSIONS.has(ext);
}

export function isTestFile(relPath: string): boolean {
  const normalized = normalizePath(relPath);
  const base = path.posix.basename(normalized);
  return (
    TEST_MARKERS.some((marker) => `/${normalized}`.includes(marker)) ||
    base.startsWith("test_") ||
    base.endsWith("_test.py") ||
    base.endsWith("_test.go")
  );
}

export function isConfigOrEntrypoint(relPath: string): boolean {
  const base = path.posix.basename(relPath);
  const stem = path.posix.parse(relPath).name.toLowerCase();
  return CONFIG_FILENAMES.has(base) || ENTRYPOINT_NAMES.has(stem);
}

export function filePriority(relPath: string): [number, number, number, string] {
  const normalized = normalizePath(relPath);
  const parts = normalized.split("/");
  let score = 50;

  if (isConfigOrEntrypoint(normalized)) {
    score -= 25;
  }
  if (["src", "lib", "app", "packages", "cmd", "internal"].includes(parts[0] ?? "")) {
    score -= 10;
  }
  if (isTestFile(normalized)) {
    score += 25;
  }
  if (parts.some((part) => IGNORE_DIRS.has(part))) {
    score += 50;
  }

  const depth = normalized.split("/").length - 1;
  return [score, depth, normalized.length, normalized];
}

export function prioritizeFiles(files: Iterable<string>): string[] {
  return [...files].sort((left, right) => {
    const leftKey = filePriority(left);
    const rightKey = filePriority(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] < rightKey[index]) {
        return -1;
      }
      if (leftKey[index] > rightKey[index]) {
        return 1;
      }
    }
    return 0;
  });
}

export function languageStats(files: Iterable<string>): Record<string, number> {
  const stats = new Map<string, number>();
  for (const filePath of files) {
    const language = EXT_TO_LANG[path.extname(filePath)] ?? "other";
    stats.set(language, (stats.get(language) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...stats.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

export function pairTests(files: string[]): Record<string, string[]> {
  const tests = files.filter((file) => isTestFile(file));
  const sources = files.filter((file) => !isTestFile(file) && SUPPORTED_EXTENSIONS.has(path.extname(file)));
  const pairs = new Map<string, string[]>();

  for (const source of sources) {
    const stem = path.parse(source).name;
    const sourceParts = new Set(normalizePath(source).split("/"));
    const matches = tests.filter((test) => {
      const testStem = path.parse(test).name.replace(".test", "").replace(".spec", "");
      const testParts = normalizePath(test).split("/");
      return (
        stem === testStem ||
        test.includes(stem) ||
        testParts.some((part) => sourceParts.has(part))
      );
    });

    if (matches.length > 0) {
      pairs.set(source, [...matches].sort());
    }
  }

  return Object.fromEntries([...pairs.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}
