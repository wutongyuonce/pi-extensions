import { vi } from "vitest";
import { makeLspServiceDouble } from "./lsp-service-double.js";

/**
 * Shared seams for the LSP status-repaint cases (#281, #3099).
 *
 * Both `index-lsp-idle-reset` and `index-integration` need the same two things:
 * an alive-server holder the idle-reset double can empty (that is what makes the
 * second repaint observable) and a recorder for the `pi-lens-lsp` status writes.
 * Keeping them here means a new status-repaint case does not restate the
 * harness, and the module-mock specifiers stay in the test file, where they
 * resolve against that file's directory.
 */

/**
 * Alive-server holder + the reset double that empties it. `service` is the
 * `getLSPService` factory to install through the test's own `vi.doMock`.
 */
export function aliveServerHolder(initialAliveIds: string[] = ["typescript"]) {
	let aliveIds = initialAliveIds;
	const resetLSPService = vi.fn(() => {
		aliveIds = [];
	});
	const service = () =>
		makeLspServiceDouble({
			getAliveClientCount: () => aliveIds.length,
			getAliveServerIds: () => aliveIds,
		});
	return { resetLSPService, service };
}

/**
 * Identity-theme `ctx.ui` double that records every `setStatus` call, plus a
 * `lspStatuses()` reader for the `pi-lens-lsp` writes only.
 */
export function lspStatusRecorder() {
	const statusUpdates: Array<[string, string | undefined]> = [];
	const ui = {
		notify: vi.fn(),
		setStatus: (id: string, text: string | undefined) =>
			statusUpdates.push([id, text]),
		theme: { fg: (_color: string, text: string) => text },
	};
	const lspStatuses = () =>
		statusUpdates.flatMap(([id, text]) => (id === "pi-lens-lsp" ? [text] : []));
	return { ui, lspStatuses };
}
