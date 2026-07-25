export type ReviewMode = "checkpoint" | "head";
export type ChangeStatus = "modified" | "added" | "deleted";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  fingerprint: string;
  recentAt?: number;
}

export interface WorkspaceState {
  repoRoot: string;
  repoName: string;
  branch: string | null;
  mode: ReviewMode;
  hasCheckpoint: boolean;
  checkpointCreatedAt?: number;
  files: ChangedFile[];
  pendingFiles: ChangedFile[];
  recentPaths: string[];
}

export interface FileContents {
  path: string;
  mode: ReviewMode;
  fingerprint: string;
  originalContent: string;
  modifiedContent: string;
}

export interface ReviewComment {
  path: string;
  mode?: ReviewMode;
  side: "original" | "modified" | "file";
  line: number | null;
  body: string;
}

export interface StoredFilePresent {
  state: "present";
  fingerprint: string;
  encoding: "gzip+base64";
  content: string;
}

export interface StoredFileDeleted {
  state: "deleted";
}

export type StoredFile = StoredFilePresent | StoredFileDeleted;

export interface ReviewCheckpoint {
  version: 1;
  id: string;
  repoRoot: string;
  createdAt: number;
  headSha: string | null;
  overrides: Record<string, StoredFile>;
  reviewedPaths: string[];
  feedback: string;
}

export type WindowMessage =
  | { type: "ready" }
  | { type: "set-mode"; mode: ReviewMode }
  | { type: "request-file"; path: string; mode: ReviewMode; requestId: string }
  | { type: "submit-review"; comments: ReviewComment[] };

export type HostMessage =
  | { type: "workspace"; state: WorkspaceState }
  | { type: "file"; requestId: string; file: FileContents }
  | { type: "file-error"; requestId: string; message: string }
  | { type: "review-submitted"; checkpointAt: number; insertedFeedback: boolean };
