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

	/** Forget the memoized go path and latched availability verdict — #2455. */
	resetAvailability(): void {
		this.availability.reset();
	}
}

/**
 * The one `GoClient` this process owns (#2455 fix round 4, F2).
 *
 * `GoClient` is not stateless: it wraps a `createToolchainAvailability` latch
 * whose probe-class "missing" verdict never expires (`isLatchingOutcome`), and
 * `resetGoAvailability` below re-arms exactly ONE such latch. Round 2 shipped
 * with two instances — `dispatch/runners/go-vet.ts` built one for the runner
 * and `bootstrap.ts` built another for `BootstrapClients.goClient`, which is
 * the object `handleSessionStart` reads for its "Active tools" line. The
 * session reset cleared the runner's copy and left the session-start copy
 * latched, so a go toolchain installed between sessions stayed invisible on
 * the surface a user actually sees. One instance, in the module that owns the
 * class, is what makes the reset total; `tests/clients/toolchain-client-singleton.test.ts`
 * holds the line.
 */
export const goClient = new GoClient();

/**
 * Forget `goClient`'s memoized go path and latched availability verdict —
 * #2455. Same #1496/#1535 shape as `resetZizmorTokenAvailability`; wired into
 * `handleSessionStart` beside it (`clients/runtime-session.ts`) so a go
 * toolchain installed mid-process is observed by the next session instead of
 * staying "missing" for the rest of the process's life.
 *
 * This module — not `go-vet.ts` — because the reset must sit beside the single
 * instance it clears (#2455 fix round 4, F2). It was invisible to the
 * session-state sweep before round 2, but not for the reason an earlier draft
 * of this comment gave (#2455 fix round 3, F4): the sweep skips any file
 * exporting no reset at all, so widening the container predicate to "any class
 * declared in `clients/`" could not have surfaced it. Adding this reset is
 * what made the file visible — the fix preceded the detection, and the
 * pair-with-reset blind spot (MISS 3 in `SWEEP_HEURISTIC_LIMITS`) is unchanged.
 */
export function resetGoAvailability(): void {
	goClient.resetAvailability();
}
