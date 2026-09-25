import {
	type GzipStageWorkerRequest,
	type GzipStageWorkerResult,
	serveGzipStageWorker,
} from "./gzip-stage-write.js";
import { fingerprintProjectSnapshotJson } from "./project-snapshot-fingerprint.js";

/**
 * Worker-thread persist for the project snapshot BODY (#958 item 2). The parent
 * (project-snapshot.ts) posts the (large) snapshot object plus a monotonic
 * `generation` and a per-generation `stagePath`; the streamed stringify+gzip
 * runs entirely off the main thread via the shared gzip-stage worker loop
 * (clients/gzip-stage-write.ts, also used by the review-graph persist worker).
 * The parent does the generation-gated promotion (rename stage → canonical) so
 * a slow write for an older generation can never clobber a newer snapshot.
 * The request also carries the last successfully published fingerprint so the
 * worker can skip gzip and staging when only `generatedAt` changed.
 */
export interface ProjectSnapshotPersistWorkerRequest extends GzipStageWorkerRequest {
	/** Last body digest known to have reached canonical storage. */
	priorFingerprints?: string[];
}

export type ProjectSnapshotPersistWorkerResult = GzipStageWorkerResult;

/**
 * Hash the serialized body while replacing only the top-level volatile
 * `generatedAt` value with a stable sentinel. This runs after the worker has
 * already paid the unavoidable stringify cost. It never walks the snapshot on
 * the extension host's event loop.
 */
function semanticSnapshotFingerprint(
	request: ProjectSnapshotPersistWorkerRequest,
	json: string,
): string {
	const generatedAt = (request.data as { generatedAt?: unknown }).generatedAt;
	return fingerprintProjectSnapshotJson(
		json,
		typeof generatedAt === "string" ? generatedAt : "",
	);
}

serveGzipStageWorker<
	ProjectSnapshotPersistWorkerRequest,
	ProjectSnapshotPersistWorkerResult
>(
	(request) => ({
		id: request.id,
		generation: request.generation,
		stagePath: request.stagePath,
	}),
	{
		semanticFingerprint: semanticSnapshotFingerprint,
		skipIfFingerprints: (request) => request.priorFingerprints,
	},
);
