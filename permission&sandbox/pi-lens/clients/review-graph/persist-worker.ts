import {
	type GzipStageWorkerRequest,
	type GzipStageWorkerResult,
	serveGzipStageWorker,
} from "../gzip-stage-write.js";

export interface ReviewGraphPersistWorkerRequest extends GzipStageWorkerRequest {
	cwd: string;
	elements: number;
}

export interface ReviewGraphPersistWorkerResult extends GzipStageWorkerResult {
	cwd: string;
	elements: number;
}

// Streamed gzip stage write runs off the main thread via the shared core (see
// clients/gzip-stage-write.ts); this worker only echoes its routing fields.
serveGzipStageWorker<
	ReviewGraphPersistWorkerRequest,
	ReviewGraphPersistWorkerResult
>((request) => ({
	id: request.id,
	cwd: request.cwd,
	generation: request.generation,
	stagePath: request.stagePath,
	elements: request.elements,
}));
