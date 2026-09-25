export type FetchFn = (
	url: string,
	init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

export type ClassificationKind = "real" | "infra-kill" | "infra-net";
export interface Classification {
	kind: ClassificationKind;
	detail: string;
}
export type RerunState = "true" | "false" | `failed:${number}`;
export interface ClassifierMarker {
	sha: string;
	// Optional on the TYPE (shouldTriggerRerun's guard only reads sha +
	// rerunTriggered) even though parseClassifierMarker always sets it.
	rerunState?: string;
	rerunTriggered: boolean;
}
export interface ClassifierDecision {
	classification: Classification;
	// "did THIS pass trigger a rerun" -- distinct from ClassifierMarker's
	// `rerunTriggered`, which is the marker's CUMULATIVE state (review round
	// 2, V5: kept as two differently-named fields on purpose).
	rerunTriggeredThisPass: boolean;
	commentBody: string;
}

export declare function stripAnsi(text: string): string;
export declare function stripLineTimestamps(text: string): string;
export declare function classifyFailureLog(rawLog: string): Classification;
export declare function readCgroupOomKillCount(log: string): number | null;
export declare function describeKernelKillEvidence(log: string): string | null;
export declare function buildMarker(sha: string, rerunState: string): string;
export declare function parseClassifierMarker(
	commentBody: string | null | undefined,
): ClassifierMarker | null;
export declare function shouldTriggerRerun(args: {
	classification: Classification;
	sha: string;
	existingMarker: ClassifierMarker | null;
	rerunKinds?: ClassificationKind[];
}): boolean;
export declare function buildCommentBody(args: {
	classification: Classification;
	sha: string;
	rerunState: string;
}): string;
export declare function decideClassifierAction(args: {
	rawLog: string;
	sha: string;
	existingCommentBody: string | null | undefined;
}): ClassifierDecision;

export interface FetchedJob {
	sha: string;
	prNumber: number | null;
	jobId: number;
	jobName: string;
}
export declare function fetchRunAndFailedJob(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	runId: number | string;
	jobName?: string;
}): Promise<FetchedJob>;
export declare function fetchJobLog(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	jobId: number;
}): Promise<string>;
export declare function findExistingClassifierComment(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	prNumber: number;
}): Promise<{ id: number; body: string } | null>;
export declare function upsertComment(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	prNumber: number;
	existingComment: { id: number; body: string } | null;
	body: string;
}): Promise<{ id: number; body: string } | null>;
export declare function reconcileDuplicateClassifierComments(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	prNumber: number;
	sha: string;
	postedCommentId: number | undefined;
}): Promise<{ isWinner: boolean; winningCommentId: number | undefined }>;
export declare function attemptRerun(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	runId: number | string;
}): Promise<{ ok: boolean; status: number }>;
export interface RunClassifierArgs {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	runId: number | string;
	jobName?: string;
	prNumber?: number;
	sha?: string;
	rerunKinds?: ClassificationKind[];
	skipMissingJob?: boolean;
}
export type SuccessfulClassifierRun = ClassifierDecision & {
	sha: string;
	prNumber: number;
	jobId: number;
	jobName: string;
	supersededByCommentId?: number;
};
export type SkippedClassifierRun = { skipped: true; reason: string };
export declare function runClassifier(
	args: RunClassifierArgs & { skipMissingJob?: false },
): Promise<SuccessfulClassifierRun>;
export declare function runClassifier(
	args: RunClassifierArgs & { skipMissingJob: true },
): Promise<SuccessfulClassifierRun | SkippedClassifierRun>;
export declare function runClassifier(
	args: RunClassifierArgs,
): Promise<SuccessfulClassifierRun | SkippedClassifierRun>;
export declare function commentClassificationFailure(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	prNumber?: number;
	sha?: string;
	error: unknown;
}): Promise<boolean>;
