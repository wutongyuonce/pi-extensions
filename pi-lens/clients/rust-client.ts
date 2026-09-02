/**
 * Rust Client for pi-lens
 *
 * Provides Rust type checking and linting via cargo check and clippy.
 *
 * Requires: cargo (rustup)
 * Docs: https://doc.rust-lang.org/cargo/
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as path from "node:path";
import {
	type ToolchainAvailability,
	createToolchainAvailability,
} from "./dispatch/runners/utils/toolchain-availability.js";

// --- Types ---

export interface RustDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "note" | "help";
	message: string;
	code?: string;
	file: string;
}

// --- Common install paths ---

const CARGO_WINDOWS_PATHS = [
	path.join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe"),
	path.join(process.env.SYSTEMDRIVE || "C:", "\\cargo", "bin", "cargo.exe"),
	"cargo.exe", // PATH
];

/** Budget for the PATH candidate's `cargo --version` probe, ms. */
const PROBE_TIMEOUT_MS = 3_000;

const CARGO_UNIX_PATHS = [
	path.join(process.env.HOME || "", ".cargo", "bin", "cargo"),
	"/usr/local/cargo/bin/cargo",
	"/usr/bin/cargo",
	"cargo", // PATH
];

// --- Client ---

export class RustClient {
	/**
	 * Availability lifecycle, behind the shared transient-aware latch (#1476).
	 * The PATH candidate is resolved by spawning `cargo --version` with a 3 s
	 * budget, so a host stall could latch "no cargo" for the session and silently
	 * disable every Rust diagnostic until restart.
	 */
	private readonly availability: ToolchainAvailability;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("rust") : () => {};
		this.availability = createToolchainAvailability({
			tool: "cargo",
			label: "Cargo",
			windowsPaths: CARGO_WINDOWS_PATHS,
			unixPaths: CARGO_UNIX_PATHS,
			probeArgs: ["--version"],
			budgetMs: PROBE_TIMEOUT_MS,
			log: (msg) => this.log(msg),
		});
	}

	/**
	 * Find cargo executable path (async — probes PATH candidates off the event loop).
	 */
	async findCargoPathAsync(): Promise<string | null> {
		return this.availability.findPath();
	}

	/**
	 * Check if cargo is installed (cached)
	 */
	async isAvailableAsync(): Promise<boolean> {
		return this.availability.isAvailable();
	}

	/**
	 * Check if a file is a Rust file
	 */
	isRustFile(filePath: string): boolean {
		return path.extname(filePath).toLowerCase() === ".rs";
	}
}
