import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const GLOB_MAGIC = /[*?[\]]/;

export function normalizePathToken(token) {
  const value = String(token ?? "").trim().replace(/^['"`]+|['"`]+$/g, "");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

export function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

function realpathOrNull(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return null;
  }
}

function closestExistingAncestor(pathname) {
  let current = pathname;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export function canonicalizeTargetPath(cwd, rawPath) {
  const normalized = normalizePathToken(rawPath);
  if (/^~[^/]/.test(normalized)) return null;
  const requestedPath = resolve(cwd, normalized);
  const ancestor = closestExistingAncestor(requestedPath);
  if (!ancestor) return null;
  const ancestorReal = realpathOrNull(ancestor);
  if (!ancestorReal) return null;
  const rel = relative(ancestor, requestedPath);
  return rel ? resolve(ancestorReal, rel) : ancestorReal;
}

export function getWorkspaceRoot(cwd) {
  return realpathOrNull(cwd) ?? resolve(cwd);
}

export function isInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function toWorkspaceRelative(root, candidate) {
  const rel = relative(root, candidate);
  return normalizeSlashes(rel);
}

export function hasGlobMagic(pattern) {
  return GLOB_MAGIC.test(pattern);
}

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob, { matchSubpaths = false } = {}) {
  let regex = "^";
  const source = normalizeSlashes(glob);
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "*") {
      if (source[i + 1] === "*") {
        regex += ".*";
        i += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(char);
    }
  }
  if (matchSubpaths) regex += "(?:$|/.*)";
  else regex += "$";
  return new RegExp(regex);
}

export function normalizeSensitivePathPattern(rawPattern) {
  const pattern = normalizeSlashes(normalizePathToken(rawPattern));
  if (hasGlobMagic(pattern)) return pattern;
  return normalizeSlashes(realpathOrNull(pattern) ?? pattern);
}

export function matchesPathOrDescendant(candidatePath, rawPattern) {
  const pattern = normalizeSensitivePathPattern(rawPattern).replace(/\/+$/, "");
  const candidate = normalizeSlashes(candidatePath).replace(/\/+$/, "");
  if (!hasGlobMagic(pattern)) {
    return candidate === pattern || candidate.startsWith(`${pattern}/`);
  }
  return globToRegExp(pattern, { matchSubpaths: true }).test(candidate);
}

function matchesSegmentPattern(segments, pattern) {
  const regex = globToRegExp(pattern);
  return segments.some((segment) => regex.test(segment));
}

export function matchesWorkspacePattern(relativePath, rawPattern) {
  const pathValue = normalizeSlashes(relativePath).replace(/^\.\//, "");
  const segments = pathValue.split("/").filter(Boolean);
  const pattern = normalizeSlashes(rawPattern).replace(/^\.\//, "").replace(/\/+$/, "");

  if (!pattern.includes("/")) {
    if (!hasGlobMagic(pattern)) return segments.includes(pattern);
    return matchesSegmentPattern(segments, pattern);
  }

  if (!hasGlobMagic(pattern)) {
    return pathValue === pattern || pathValue.startsWith(`${pattern}/`);
  }

  return globToRegExp(pattern, { matchSubpaths: true }).test(pathValue);
}
