/** Shared lazy LSP service seam (#1394). */
import { createLazyImport } from "./lazy-import.js";

type LspModule = typeof import("./lsp/index.js");
const lazyLsp = createLazyImport<LspModule>(() => import("./lsp/index.js"));

export function warmLspService(): Promise<LspModule> {
	return lazyLsp.get();
}

export function loadLspService(): Promise<LspModule> {
	return warmLspService();
}
