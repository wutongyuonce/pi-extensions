import {
	attemptMutation,
	canMutate,
	moveItem,
	moveItemBefore,
	preferNewestState,
} from "./state.js";
import type {
	ImageDropState,
	ImageDropView,
	RequestOptions,
	RestageState,
	UploadState,
} from "./types.js";

interface PendingUpload {
	id: string;
	name: string;
	size: number;
	file: File;
}

class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

class ImageDropClient {
	private readonly clientId = crypto.randomUUID();
	private readonly listeners = new Set<() => void>();
	private readonly pendingFiles = new Map<string, File>();
	private view: ImageDropView = { error: "" };
	private events?: EventSource;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private highlightTimer?: ReturnType<typeof setTimeout>;
	private started = false;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly getSnapshot = (): ImageDropView => this.view;

	start(): void {
		if (this.started) return;
		this.started = true;
		void this.initialize();
	}

	async addFiles(fileList: Iterable<File> | ArrayLike<File> | null): Promise<void> {
		const state = this.view.state;
		const files = fileList ? Array.from(fileList) : [];
		if (!state || files.length === 0) return;
		if (!canMutate(state.batch)) {
			this.showError("This batch is already queued with Pi.");
			return;
		}
		this.clearError();
		const items: PendingUpload[] = files.map((file) => ({
			id: crypto.randomUUID(),
			name: file.name || "pasted-image",
			size: file.size,
			file,
		}));
		try {
			this.applyState(
				await this.request<ImageDropState>("/api/items", {
					method: "POST",
					json: {
						revision: state.batch.revision,
						items: items.map(({ id, name, size }) => ({ id, name, size })),
					},
				}),
			);
			for (const item of items) this.pendingFiles.set(item.id, item.file);
			this.emit();
			await mapConcurrent(items, 4, (item) => this.upload(item));
		} catch (error) {
			this.showError(errorMessage(error));
		}
	}

	async retry(id: string): Promise<void> {
		try {
			const file = this.pendingFiles.get(id);
			const response = file
				? await this.request<UploadState>(`/api/items/${id}/content`, {
						method: "PUT",
						body: file,
						headers: { "content-type": "application/octet-stream" },
					})
				: await this.request<UploadState>(`/api/items/${id}/retry`, { method: "POST" });
			this.applyState(response);
			if (response.duplicateOf) this.highlight(response.duplicateOf);
			if (!this.hasErroredItem(id)) this.pendingFiles.delete(id);
			this.clearError();
			this.emit();
		} catch (error) {
			this.showError(
				`${errorMessage(error)} Delete and choose the image again if its source is unavailable.`,
			);
		}
	}

	async remove(id: string): Promise<void> {
		const state = this.view.state;
		if (!state) return;
		if (
			await this.mutate(`/api/items/${id}?revision=${state.batch.revision}`, {
				method: "DELETE",
			})
		) {
			this.pendingFiles.delete(id);
		}
	}

	async move(id: string, direction: number): Promise<void> {
		const state = this.view.state;
		if (!state) return;
		await this.reorder(moveItem(this.ids(), id, direction));
	}

	async moveBefore(id: string, targetId: string): Promise<void> {
		await this.reorder(moveItemBefore(this.ids(), id, targetId));
	}

	async clearAll(): Promise<void> {
		const state = this.view.state;
		if (!state) return;
		if (
			await this.mutate("/api/clear", {
				method: "POST",
				json: { revision: state.batch.revision },
			})
		) {
			this.pendingFiles.clear();
		}
	}

	async restageHistory(historyId: string): Promise<void> {
		const state = this.view.state;
		if (!state) return;
		try {
			const response = await this.request<RestageState>("/api/history/restage", {
				method: "POST",
				json: {
					revision: state.batch.revision,
					items: [{ historyId, id: crypto.randomUUID() }],
				},
			});
			this.applyState(response);
			this.clearError();
			this.emit();
			const target = response.restage.addedIds[0] ?? response.restage.duplicates[0]?.existingId;
			if (target) this.highlight(target);
		} catch (error) {
			this.showError(errorMessage(error));
		}
	}

	async deleteHistory(id: string): Promise<void> {
		const state = this.view.state;
		if (!state) return;
		await this.mutate(`/api/history/${id}?revision=${state.batch.revision}`, {
			method: "DELETE",
		});
	}

	async clearHistory(): Promise<void> {
		const state = this.view.state;
		if (!state) return;
		await this.mutate("/api/history/clear", {
			method: "POST",
			json: { revision: state.batch.revision },
		});
	}

	private async initialize(): Promise<void> {
		try {
			this.applyState(
				await this.request<ImageDropState>("/api/lease", {
					method: "POST",
					json: { clientId: this.clientId },
				}),
			);
			this.emit();
			this.connectEvents();
		} catch (error) {
			this.failConnection("Could not connect", errorMessage(error));
		}
	}

	private connectEvents(): void {
		this.events?.close();
		const events = new EventSource(`/api/events?client=${encodeURIComponent(this.clientId)}`);
		this.events = events;
		events.addEventListener("state", (event) => {
			clearTimeout(this.reconnectTimer);
			this.applyState(JSON.parse(event.data) as ImageDropState);
			this.reconcileFiles();
			this.emit();
		});
		events.addEventListener("stale", (event) => {
			events.close();
			const payload = JSON.parse(event.data) as { message: string };
			this.failConnection("Opened in another tab", payload.message);
		});
		events.addEventListener("session-ended", (event) => {
			events.close();
			const payload = JSON.parse(event.data) as { message: string };
			this.failConnection("Pi session ended", payload.message);
		});
		events.onerror = () => {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = setTimeout(async () => {
				try {
					this.applyState(await this.request<ImageDropState>("/api/state"));
					this.emit();
				} catch {
					events.close();
					this.failConnection("Connection lost", "Run /image-drop in Pi for a new link.");
				}
			}, 2_000);
		};
	}

	private async upload(item: PendingUpload): Promise<void> {
		try {
			const response = await this.request<UploadState>(`/api/items/${item.id}/content`, {
				method: "PUT",
				body: item.file,
				headers: { "content-type": "application/octet-stream" },
			});
			this.applyState(response);
			if (response.duplicateOf) this.highlight(response.duplicateOf);
			if (!this.hasErroredItem(item.id)) this.pendingFiles.delete(item.id);
			this.emit();
		} catch (error) {
			try {
				if (!(error instanceof ApiError) || error.status === 413) {
					this.applyState(
						await this.request<ImageDropState>(`/api/items/${item.id}/fail`, {
							method: "POST",
							json: { error: `Upload failed: ${errorMessage(error)}` },
						}),
					);
				} else {
					this.applyState(await this.request<ImageDropState>("/api/state"));
				}
				this.emit();
			} catch {
				// The Pi session may have disconnected while the upload failed.
			}
			this.showError(errorMessage(error));
		}
	}

	private async reorder(ids: string[]): Promise<void> {
		const state = this.view.state;
		if (!state || ids.every((id, index) => state.batch.items[index]?.id === id)) return;
		await this.mutate("/api/order", {
			method: "PUT",
			json: { revision: state.batch.revision, ids },
		});
	}

	private async mutate(path: string, options: RequestOptions): Promise<boolean> {
		const result = await attemptMutation(() => this.request<ImageDropState>(path, options));
		if (!result.ok) {
			this.showError(errorMessage(result.error));
			return false;
		}
		this.applyState(result.value);
		this.clearError();
		this.emit();
		return true;
	}

	private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const headers = new Headers(options.headers);
		headers.set("x-image-drop-client", this.clientId);
		let body = options.body;
		if (options.json !== undefined) {
			headers.set("content-type", "application/json");
			body = JSON.stringify(options.json);
		}
		const response = await fetch(path, { method: options.method, headers, body });
		const data = (response.headers.get("content-type") ?? "").includes("application/json")
			? ((await response.json()) as { error?: string } & T)
			: undefined;
		if (!response.ok) {
			throw new ApiError(
				response.status,
				data?.error ?? `Image Drop request failed (${response.status})`,
			);
		}
		return data as T;
	}

	private ids(): string[] {
		return this.view.state?.batch.items.map((item) => item.id) ?? [];
	}

	private hasErroredItem(id: string): boolean {
		return Boolean(
			this.view.state?.batch.items.some((item) => item.id === id && item.status === "error"),
		);
	}

	private applyState(next: ImageDropState): void {
		this.view = { ...this.view, state: preferNewestState(this.view.state, next) };
	}

	private reconcileFiles(): void {
		for (const id of this.pendingFiles.keys()) {
			if (!this.view.state?.batch.items.some((item) => item.id === id)) {
				this.pendingFiles.delete(id);
			}
		}
	}

	private highlight(id: string): void {
		clearTimeout(this.highlightTimer);
		this.view = { ...this.view, highlightedId: id, focusTarget: id };
		this.emit();
		this.highlightTimer = setTimeout(() => {
			this.view = { ...this.view, highlightedId: undefined, focusTarget: undefined };
			this.emit();
		}, 1_800);
	}

	private clearError(): void {
		if (!this.view.error) return;
		this.view = { ...this.view, error: "" };
	}

	private showError(error: string): void {
		this.view = { ...this.view, error };
		this.emit();
	}

	private failConnection(title: string, message: string): void {
		this.view = { ...this.view, connectionFailure: { title, message } };
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

async function mapConcurrent<T>(
	values: readonly T[],
	limit: number,
	task: (value: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, values.length) }, async () => {
			while (cursor < values.length) {
				const value = values[cursor++];
				if (value !== undefined) await task(value);
			}
		}),
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const imageDropClient = new ImageDropClient();
