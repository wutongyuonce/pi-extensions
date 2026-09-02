// Types for the (plain-JS) tool-smoke harness, so TS consumers — e.g. the
// smoke-fixture-coverage drift guard — can import its fixture arrays.
export interface SmokeFixture {
	lang: string;
	dir: string;
	file: string;
	targets?: string[];
	tools?: string[];
	expectDiagnostic?: boolean;
	/**
	 * In the tier-1 parser lane (#1937): the tool installs as a pip/npm package
	 * or a single GitHub-release binary, with no language toolchain step.
	 */
	tier1?: boolean;
}
export interface LspFixture {
	lang: string;
	dir: string;
	file: string;
	serverHint: string;
	tools?: string[];
	/** Auxiliary (diagnostic-only) servers attached alongside the primary. */
	auxiliaryServerIds?: string[];
	auxiliarySourceMatch?: string;
	gitInit?: boolean;
	clean?: boolean;
	lombokJar?: boolean;
	expectNoMessageMatch?: string;
	/** A diagnostic message that MUST arrive. The lane's default verdict passes
	 * on zero diagnostics, which is backwards for a fixture whose purpose is to
	 * prove a defect is seen; setting this makes zero diagnostics a FAILURE. */
	expectMessageMatch?: string;
	disableServers?: string[];
	expectServerId?: string;
	expectSourceMatch?: string;
	/** Optional pre-touch setup step, run in the COPIED temp workspace (#530) — a
	 * string command (split on whitespace) or an argv array. Bounded by
	 * FIXTURE_SETUP_TIMEOUT_MS; failure reports a distinct `setup-failed`
	 * status, never a false pass. */
	setup?: string | string[];
	/** Optional expected `launchVariant` from the live capability snapshot
	 * (`getCapabilitySnapshots`), e.g. "native-ts7" (#526/#530). A mismatch —
	 * including a silent fallback to classic — is a FAILURE even when
	 * diagnostics arrived. */
	expectLaunchVariant?: string;
}
export interface FormatFixture {
	lang: string;
	dir: string;
	file: string;
	formatter: string;
	tools?: string[];
	/**
	 * "reformat" (default) — the formatter must rewrite the mis-formatted file.
	 * "preserve" — #1144's style-preserving refusal: the formatter is selected
	 * but must leave an unconfigured, style-less file byte-identical.
	 */
	expect?: "reformat" | "preserve";
}
export interface AutofixFixture {
	lang: string;
	dir: string;
	file: string;
	tool: string;
	tools?: string[];
}
/** One LSP diagnostic, as far as the harness's verdicts are concerned. */
export interface SmokeDiagnostic {
	message?: string;
	source?: string;
	severity?: number;
}
/**
 * Diagnostics whose `message` matches `pattern` (case-insensitive). Exported so
 * an `expectMessageMatch` fixture's pass/fail decision is testable without a
 * live language server.
 */
export function matchDiagnosticMessages(
	pattern: string,
	diags: readonly SmokeDiagnostic[] | undefined,
): SmokeDiagnostic[];
/** One reported row from a smoke lane, as far as the pass floor is concerned. */
export interface SmokeRow {
	state: "pass" | "fail" | "skip" | "setup-failed";
}
/**
 * The message for a run that passed fewer than `minPass` rows, or null when the
 * floor holds. Exported so the floor is testable without a live tool install.
 */
export function passFloorBreach(
	rows: readonly SmokeRow[],
	minPass: number | null | undefined,
): string | null;
/** Fixtures flagged `tier1` — the scheduled parser lane's selection. */
export function tier1Fixtures(): SmokeFixture[];
export const FIXTURES: SmokeFixture[];
export const LSP_FIXTURES: LspFixture[];
export const FORMAT_FIXTURES: FormatFixture[];
export const AUTOFIX_FIXTURES: AutofixFixture[];
