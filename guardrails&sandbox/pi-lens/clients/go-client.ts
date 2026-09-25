/**
 * Go Client for pi-lens
 *
 * Provides Go type checking and linting via gopls and go vet.
 *
 * Requires: gopls (go install golang.org/x/tools/gopls@latest)
 * Docs: https://pkg.go.dev/golang.org/x/tools/gopls
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as path from "node:path";
import {
	type ToolchainAvailability,
	createToolchainAvailability,
} from "./dispatch/runners/utils/toolchain-availability.js";

// --- Types ---

export interface GoDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info";
	message: string;
	rule?: string;
	file: string;
}

// --- Common install paths ---

const GO_WINDOWS_PATHS = [
	"C:\\Program Files\\Go\\bin\\go.exe",
	"C:\\Go\\bin\\go.exe",
	"go.exe", // PATH
];

/** Budget for the PATH candidate's `go version` probe, ms. */
const PROBE_TIMEOUT_MS = 3_000;

const GO_UNIX_PATHS = [
	"/usr/local/go/bin/go",
	"/usr/bin/go",
	"go", // PATH
];

// --- Client ---

export class GoClient {
	/**
	 * Availability lifecycle, behind the shared transient-aware latch (#1476).
	 * The PATH candidate is resolved by spawning `go version` with a 3 s budget,
	 * so a host stall could latch "no Go toolchain" for the whole session and
	 * silently disable every Go diagnostic until restart.
	 */
	private readonly availability: ToolchainAvailability;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("go") : () => {};
		this.availability = createToolchainAvailability({
			tool: "go",
			label: "Go",
			windowsPaths: GO_WINDOWS_PATHS,
			unixPaths: GO_UNIX_PATHS,
			probeArgs: ["version"],
			budgetMs: PROBE_TIMEOUT_MS,
			log: (msg) => this.log(msg),
		});
	}

	/**
	 * Find go executable path (async — probes PATH candidates off the event loop).
	 */
	async findGoPathAsync(): Promise<string | null> {
		return this.availability.findPath();
	}

	/**
	 * Check if Go is installed (cached)
	 */
	async isGoAvailableAsync(): Promise<boolean> {
		return this.availability.isAvailable();
	}

	/**
	 * Check if a file is a Go file
	 */
	isGoFile(filePath: string): boolean {
		return path.extname(filePath).toLowerCase() === ".go";
	}
}
