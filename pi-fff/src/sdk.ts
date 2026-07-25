import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-node";

export const SCAN_TIMEOUT_MS = 15_000;

/** pi can be run either under node or sdk, we resolve correct SDK version at runtime */
export type FileFinderStatic = {
  create(options: InitOptions): Result<FileFinderApi>;
};

let sdkPromise: Promise<{ FileFinder: FileFinderStatic }> | null = null;

function detectRuntime(): "bun" | "node" {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return "bun";
  if (
    typeof process !== "undefined" &&
    (process as { versions?: { bun?: string } }).versions?.bun
  )
    return "bun";
  return "node";
}

export function loadSdk(): Promise<{ FileFinder: FileFinderStatic }> {
  if (sdkPromise) return sdkPromise;

  // default to node as it seems like default option
  const pkg = detectRuntime() === "bun" ? "@ff-labs/fff-bun" : "@ff-labs/fff-node";
  sdkPromise = import(pkg) as Promise<{ FileFinder: FileFinderStatic }>;
  return sdkPromise;
}
