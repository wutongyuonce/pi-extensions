import { execa } from "execa";

export async function gitHead(repoPath: string): Promise<string> {
  try {
    const result = await execa("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      timeout: 5_000,
    });
    return result.stdout.trim();
  } catch {
    return "nogit";
  }
}
