import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileMtime, getBranchName, getHeadSha, repoName, scanAgainstCheckpoint, scanAgainstHead, type FilePair } from "./git.js";
import type { ChangedFile, FileContents, ReviewCheckpoint, ReviewMode, WorkspaceState } from "./types.js";

export class WorkspaceModel {
  private mode: ReviewMode = "checkpoint";
  private checkpoint: ReviewCheckpoint | null;
  private readonly initialHead: string | null;
  private pairsByMode = new Map<ReviewMode, Map<string, FilePair>>();
  private mtimes = new Map<string, number>();
  private branch: string | null = null;

  private constructor(
    private readonly pi: ExtensionAPI,
    readonly repoRoot: string,
    checkpoint: ReviewCheckpoint | null,
    initialHead: string | null,
  ) {
    this.checkpoint = checkpoint;
    this.initialHead = initialHead;
  }

  static async create(pi: ExtensionAPI, repoRoot: string, checkpoint: ReviewCheckpoint | null): Promise<WorkspaceModel> {
    return new WorkspaceModel(pi, repoRoot, checkpoint, await getHeadSha(pi, repoRoot));
  }

  get currentMode(): ReviewMode {
    return this.mode;
  }

  get currentCheckpoint(): ReviewCheckpoint | null {
    return this.checkpoint;
  }

  setMode(mode: ReviewMode): void {
    this.mode = mode;
  }

  setCheckpoint(checkpoint: ReviewCheckpoint): void {
    this.checkpoint = checkpoint;
    this.pairsByMode.clear();
    this.mtimes.clear();
  }

  private checkpointBaseline(): Pick<ReviewCheckpoint, "headSha" | "overrides"> {
    return this.checkpoint ?? { headSha: this.initialHead, overrides: {} };
  }

  async refresh(): Promise<WorkspaceState> {
    const [checkpointPairs, headPairs, branch] = await Promise.all([
      scanAgainstCheckpoint(this.pi, this.repoRoot, this.checkpointBaseline()),
      scanAgainstHead(this.pi, this.repoRoot),
      getBranchName(this.pi, this.repoRoot),
    ]);
    this.branch = branch;
    this.pairsByMode.set("checkpoint", new Map(checkpointPairs.map((pair) => [pair.path, pair])));
    this.pairsByMode.set("head", new Map(headPairs.map((pair) => [pair.path, pair])));

    const paths = new Set([...checkpointPairs, ...headPairs].map((pair) => pair.path));
    this.mtimes = new Map(await Promise.all([...paths].map(async (path) => [path, await fileMtime(this.repoRoot, path)] as const)));
    return this.state();
  }

  state(): WorkspaceState {
    const toChangedFile = (pair: FilePair): ChangedFile => ({
      path: pair.path,
      status: pair.status,
      fingerprint: pair.fingerprint,
      recentAt: this.mtimes.get(pair.path),
    });
    const files = [...(this.pairsByMode.get(this.mode)?.values() ?? [])].map(toChangedFile);
    const pendingFiles = [...(this.pairsByMode.get("checkpoint")?.values() ?? [])].map(toChangedFile);
    const recentPaths = [...files]
      .sort((a, b) => (b.recentAt ?? 0) - (a.recentAt ?? 0) || a.path.localeCompare(b.path))
      .map((file) => file.path);

    return {
      repoRoot: this.repoRoot,
      repoName: repoName(this.repoRoot),
      branch: this.branch,
      mode: this.mode,
      hasCheckpoint: this.checkpoint != null,
      checkpointCreatedAt: this.checkpoint?.createdAt,
      files,
      pendingFiles,
      recentPaths,
    };
  }

  getFile(path: string, mode: ReviewMode): FileContents {
    const pair = this.pairsByMode.get(mode)?.get(path);
    if (pair == null) throw new Error(`${path} is no longer changed in this mode.`);
    return {
      path,
      mode,
      fingerprint: pair.fingerprint,
      originalContent: pair.originalContent,
      modifiedContent: pair.modifiedContent,
    };
  }

  checkpointChangedPaths(): string[] {
    return [...(this.pairsByMode.get("checkpoint")?.keys() ?? [])];
  }
}
