import type {
	BatchPhase,
	HistoryRestageResult,
	ItemStatus,
	PublicBatchItem,
	PublicBatchState,
	PublicHistoryItem,
	PublicHistoryState,
} from "../../batch.js";

export type {
	BatchPhase,
	HistoryRestageResult,
	ItemStatus,
	PublicBatchItem,
	PublicBatchState,
	PublicHistoryItem,
	PublicHistoryState,
};

export interface ImageDropState {
	projectName: string;
	sessionName?: string;
	cwd: string;
	activeClientId?: string;
	batch: PublicBatchState;
	history: PublicHistoryState;
}

export interface RestageState extends ImageDropState {
	restage: HistoryRestageResult;
}

export interface UploadState extends ImageDropState {
	duplicateOf?: string;
}

export interface ConnectionFailure {
	title: string;
	message: string;
}

export interface ImageDropView {
	state?: ImageDropState;
	error: string;
	connectionFailure?: ConnectionFailure;
	highlightedId?: string;
	focusTarget?: string;
}

export interface RequestOptions {
	method?: string;
	headers?: HeadersInit;
	body?: BodyInit;
	json?: unknown;
}
