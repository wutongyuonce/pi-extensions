import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeStatus, ReviewCheckpoint, StoredFile } from "./types.js";

export interface FilePair {
  path: string;
  status: ChangeStatus;
  fingerprint: string;
  originalContent: string;
  modifiedContent: string;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], allowFailure = false): Promise<string> {
  const result = await pi.exec("git", args, { cwd });
  if (result.code !== 0) {
    if (allowFailure) return "";
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function splitZero(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const root = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
  return root.trim();
}

export async function getHeadSha(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const sha = (await git(pi, repoRoot, ["rev-parse", "--verify", "HEAD"], true)).trim();
  return sha || null;
}

export async function getBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const branch = (await git(pi, repoRoot, ["branch", "--show-current"], true)).trim();
  return branch || null;
}

export function parsePorcelainPaths(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const oldPath = fields[index + 1];
      if (oldPath) paths.push(oldPath);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

async function dirtyPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  const output = await git(pi, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return parsePorcelainPaths(output);
}

async function untrackedPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  return splitZero(await git(pi, repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], true));
}

async function currentPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  return splitZero(await git(pi, repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], true));
}

async function changedAgainst(pi: ExtensionAPI, repoRoot: string, revision: string | null): Promise<string[]> {
  if (revision == null) return currentPaths(pi, repoRoot);
  return splitZero(await git(pi, repoRoot, ["diff", "--name-only", "-z", revision, "--"], true));
}

async function readCurrent(repoRoot: string, path: string): Promise<string | null> {
  const absolute = join(repoRoot, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    return await readFile(absolute, "utf8");
  } catch {
    return null;
  }
}

async function readRevision(pi: ExtensionAPI, repoRoot: string, revision: string | null, path: string): Promise<string | null> {
  if (revision == null) return null;
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
  return result.code === 0 ? result.stdout : null;
}

export function fingerprint(content: string | null): string {
  if (content == null) return "deleted";
  return createHash("sha256").update(content).digest("hex");
}

function statusFor(original: string | null, modified: string | null): ChangeStatus {
  if (original == null) return "added";
  if (modified == null) return "deleted";
  return "modified";
}

function encodeStored(content: string | null): StoredFile {
  if (content == null) return { state: "deleted" };
  return {
    state: "present",
    fingerprint: fingerprint(content),
    encoding: "gzip+base64",
    content: gzipSync(Buffer.from(content, "utf8")).toString("base64"),
  };
}

export function decodeStored(file: StoredFile): string | null {
  if (file.state === "deleted") return null;
  return gunzipSync(Buffer.from(file.content, "base64")).toString("utf8");
}

async function baselineContent(
  pi: ExtensionAPI,
  repoRoot: string,
  checkpoint: Pick<ReviewCheckpoint, "headSha" | "overrides">,
  path: string,
): Promise<string | null> {
  const override = checkpoint.overrides[path];
  return override == null ? readRevision(pi, repoRoot, checkpoint.headSha, path) : decodeStored(override);
}

export async function scanAgainstCheckpoint(
  pi: ExtensionAPI,
  repoRoot: string,
  checkpoint: Pick<ReviewCheckpoint, "headSha" | "overrides">,
): Promise<FilePair[]> {
  const candidates = new Set<string>([
    ...(await changedAgainst(pi, repoRoot, checkpoint.headSha)),
    ...(await untrackedPaths(pi, repoRoot)),
    ...Object.keys(checkpoint.overrides),
  ]);

  const pairs = await Promise.all([...candidates].map(async (path): Promise<FilePair | null> => {
    const [originalContent, modifiedContent] = await Promise.all([
      baselineContent(pi, repoRoot, checkpoint, path),
      readCurrent(repoRoot, path),
    ]);
    if (originalContent === modifiedContent) return null;
    return {
      path,
      status: statusFor(originalContent, modifiedContent),
      fingerprint: fingerprint(modifiedContent),
      originalContent: originalContent ?? "",
      modifiedContent: modifiedContent ?? "",
    };
  }));

  return pairs.filter((pair): pair is FilePair => pair != null).sort((a, b) => a.path.localeCompare(b.path));
}

export async function scanAgainstHead(pi: ExtensionAPI, repoRoot: string): Promise<FilePair[]> {
  return scanAgainstCheckpoint(pi, repoRoot, { headSha: await getHeadSha(pi, repoRoot), overrides: {} });
}

export async function createCheckpoint(
  pi: ExtensionAPI,
  repoRoot: string,
  reviewedPaths: string[],
  feedback: string,
): Promise<ReviewCheckpoint> {
  const headSha = await getHeadSha(pi, repoRoot);
  const overrides: Record<string, StoredFile> = {};
  for (const path of await dirtyPaths(pi, repoRoot)) {
    overrides[path] = encodeStored(await readCurrent(repoRoot, path));
  }

  return {
    version: 1,
    id: randomUUID(),
    repoRoot,
    createdAt: Date.now(),
    headSha,
    overrides,
    reviewedPaths: [...new Set(reviewedPaths)].sort(),
    feedback,
  };
}

export async function fileMtime(repoRoot: string, path: string): Promise<number> {
  const absolute = join(repoRoot, path);
  try {
    return (await stat(absolute)).mtimeMs;
  } catch {
    try {
      return (await stat(dirname(absolute))).mtimeMs;
    } catch {
      return 0;
    }
  }
}

export function repoName(repoRoot: string): string {
  return basename(repoRoot);
}

export function pathExists(repoRoot: string, path: string): boolean {
  return existsSync(join(repoRoot, path));
}
