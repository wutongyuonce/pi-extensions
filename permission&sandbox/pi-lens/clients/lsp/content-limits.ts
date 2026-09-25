/**
 * The one byte/line bound on document content pi-lens hands a language server.
 *
 * #3405 r2 (M3406-1): this predicate used to exist twice — as a private
 * `exceedsLspSyncLimits` in `clients/pipeline.ts` and again inline in
 * `clients/dispatch/runners/lsp.ts` — so a THIRD writer could be added that
 * simply had neither. That is what happened: `tools/lsp-diagnostics.ts` reads a
 * whole file with `fs.readFileSync` and touches with it, and once the touch
 * could also carry `textDocument/didSave.text` (`includeText`), the same
 * unbounded string was serialized into a second JSON-RPC frame. Both callers now
 * ask this module, and so does the didSave payload seam, so the bound is one
 * constant pair in one place rather than a convention each new writer must
 * remember.
 *
 * The two established callers act on it by skipping their whole LSP step — a
 * file this large is not synced at all. That behaviour is deliberately NOT
 * folded in here: what a caller does at the bound is the caller's policy, and
 * `sendDidSave`'s is different (it drops the redundant `text` and still sends
 * the save, because the server already received these bytes in the didOpen or
 * didChange this save follows).
 */

import { RUNTIME_CONFIG } from "../runtime-config.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;

export interface LspContentLimitVerdict {
	tooLarge: boolean;
	/** Human-readable measurement, empty when within the bound. */
	reason: string;
}

export function exceedsLspSyncLimits(content: string): LspContentLimitVerdict {
	const sizeBytes = Buffer.byteLength(content, "utf-8");
	if (sizeBytes > LSP_MAX_FILE_BYTES) {
		return {
			tooLarge: true,
			reason: `${sizeBytes} bytes > ${LSP_MAX_FILE_BYTES} limit`,
		};
	}

	const lineCount = content.split("\n").length;
	if (lineCount > LSP_MAX_FILE_LINES) {
		return {
			tooLarge: true,
			reason: `${lineCount} lines > ${LSP_MAX_FILE_LINES} limit`,
		};
	}

	return { tooLarge: false, reason: "" };
}
