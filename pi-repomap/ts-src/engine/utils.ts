import { stat, readFile } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_SIZE = 500_000;

export async function readText(repoPath: string, relPath: string, maxBytes = MAX_FILE_SIZE): Promise<string> {
  try {
    const fullPath = path.join(repoPath, relPath);
    const fileStat = await stat(fullPath);
    if (fileStat.size > maxBytes) {
      return "";
    }
    return await readFile(fullPath, "utf8");
  } catch {
    return "";
  }
}

export function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
