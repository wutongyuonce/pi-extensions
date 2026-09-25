// Types for the (plain-JS) real-bytes capture primitive, so TS consumers — the
// unit tests in tests/scripts/ — can import its helpers.

/** Placeholder substituted for the capture workspace inside captured bytes. */
export const WORKSPACE_TOKEN: string;

/**
 * The first `major.minor` token in a `--version` banner, or "" when the banner
 * carries none. The caller refuses to write a fixture on "", so a failed spawn's
 * error text can never be recorded as a tool version.
 */
export function extractVersion(banner: string | undefined): string;

/**
 * `text` with every spelling of `workspace` — native, POSIX, backslash, and
 * JSON-escaped — replaced by `WORKSPACE_TOKEN`.
 */
export function redactWorkspace(
	text: string | undefined,
	workspace: string,
): string;

/** Whether this spawn needs a shell (a Windows npm shim, never a real .exe). */
export function needsShell(bin: string, platform?: NodeJS.Platform): boolean;

/**
 * One argv entry quoted per the CommandLineToArgvW rules, including the
 * backslash-run doubling a naive quote-escape gets wrong.
 */
export function quoteForShell(arg: string): string;

/** An executable path normalised and quoted for whichever shell receives it. */
export function shellBinPath(bin: string): string;
