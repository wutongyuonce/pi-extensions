/**
 * Diagnostic Logger — append-only JSONL log for cross-session analytics
 *
 * Log file: ~/.pi-lens/logs/{date}.jsonl
 */

import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

export interface DiagnosticEntry {
	// When
	timestamp: string;

	// What was caught
	tool: "biome" | "eslint" | "lsp" | "ruff" | "ast-grep" | "tree-sitter";
	ruleId: string;
	severity: "error" | "warning" | "info";
	language: string;

	// Where
	filePath: string;
	line: number;
	column: number;
	message: string;

	// What happened
	caughtByPipeline: boolean;
	shownInline: boolean;
	autoFixed: boolean;
	shownToAgent: boolean;
	agentFixed: boolean;
	unresolved: boolean;

	// Context
	model: string;
	sessionId: string;
	turnIndex: number;
	writeIndex: number;
}

export interface DiagnosticLogger {
	log(entry: DiagnosticEntry): void;
	logCaught(d: Diagnostic, context: LogContext, shownInline?: boolean): void;
	flush(): Promise<void>;
}

export interface Diagnostic {
	tool?: string;
	rule?: string;
	id?: string;
	severity?: string;
	language?: string;
	filePath: string;
	line?: number;
	column?: number;
	message?: string;
}

export interface LogContext {
	model: string;
	sessionId: string;
	turnIndex: number;
	writeIndex: number;
}

function getLogDir(): string {
	return path.join(getGlobalPiLensDir(), "logs");
}

function getLogFile(): string {
	const date = new Date().toISOString().split("T")[0];
	return path.join(getLogDir(), `${date}.jsonl`);
}

// Module-level singleton — persists across all writes
let _logger: DiagnosticLogger | null = null;

export function getDiagnosticLogger(): DiagnosticLogger {
	if (!_logger) {
		_logger = createDiagnosticLogger();
	}
	return _logger;
}

export function createDiagnosticLogger(): DiagnosticLogger {
	// Lazy filePath: the log file is keyed on the current date, resolved per
	// drain so a long-lived logger rolls over at midnight.
	const writer = createNdjsonLogger({ filePath: () => getLogFile() });

	return {
		log(entry: DiagnosticEntry) {
			if (isTestMode()) {
				return;
			}
			writer.log(entry); // async, non-blocking
		},

		logCaught(d: Diagnostic, context: LogContext, shownInline = false) {
			this.log({
				timestamp: new Date().toISOString(),
				tool: (d.tool as DiagnosticEntry["tool"]) || "unknown",
				ruleId: d.rule || d.id || "unknown",
				severity: (d.severity as DiagnosticEntry["severity"]) || "warning",
				language: d.language || "unknown",
				filePath: d.filePath,
				line: d.line || 1,
				column: d.column || 1,
				message: d.message || "",
				caughtByPipeline: true,
				shownInline,
				autoFixed: false,
				shownToAgent: shownInline,
				agentFixed: false,
				unresolved: true,
				model: context.model,
				sessionId: context.sessionId,
				turnIndex: context.turnIndex,
				writeIndex: context.writeIndex,
			});
		},

		async flush() {
			await writer.flush();
		},
	};
}
