import { afterEach, describe, expect, it, vi } from "vitest";

import {
	clientRequestWorkspaceDiagnostics,
	clientWaitForDiagnostics,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/aging.ts";

function pullState(workspaceDiagnostics = false): LSPClientState {
	return createMockState({
		serverId: "typescript",
		workspaceDiagnosticsSupport: {
			advertised: true,
			mode: "pull",
			workspaceDiagnostics,
			diagnosticProviderKind: "static",
		},
	});
}

afterEach(() => vi.useRealTimers());

describe("#1889 pull request aging", () => {
	it.each([
		["document", false],
		["workspace", true],
	] as const)(
		"keeps timed-out %s pulls bounded when the server ignores cancellation",
		async (_kind, workspaceDiagnostics) => {
			const state = pullState(workspaceDiagnostics);
			let active = 0;
			let peakActive = 0;
			let cancellations = 0;
			state.connection.sendRequest = vi.fn(
				(
					method: string,
					_params: unknown,
					token?: {
						onCancellationRequested(listener: () => void): { dispose(): void };
					},
				) => {
					const expected = workspaceDiagnostics
						? "workspace/diagnostic"
						: "textDocument/diagnostic";
					if (method !== expected) return Promise.resolve(undefined);
					active += 1;
					peakActive = Math.max(peakActive, active);
					return new Promise<undefined>(() => {
						token?.onCancellationRequested(() => {
							cancellations += 1;
						});
					});
				},
			) as unknown as typeof state.connection.sendRequest;

			for (let iteration = 0; iteration < 12; iteration += 1) {
				if (workspaceDiagnostics) {
					await clientRequestWorkspaceDiagnostics(state, 5);
				} else {
					await clientWaitForDiagnostics(state, TEST_FILE, 5, {
						pullOnly: true,
					});
				}
			}

			expect(cancellations).toBe(1);
			expect(active).toBe(1);
			expect(peakActive).toBe(1);
		},
	);
});
