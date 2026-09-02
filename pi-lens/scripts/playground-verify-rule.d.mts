// Type declarations for playground-verify-rule.mjs (untyped .mjs imported
// from .ts tests). #1679.

export interface RunCdpOptions {
	scriptPath?: string;
	timeoutMs?: number;
}

export function runCdp(
	args: string[],
	options?: RunCdpOptions,
): Promise<string>;

export interface RunChromeOptions {
	scriptPath?: string;
	timeoutMs?: number;
}

export function runChrome(
	cmd: string,
	options?: RunChromeOptions,
): Promise<void>;

// #2208.
export function buildPlaygroundUrl(
	ruleYaml: string,
	code: string,
	lang: string,
): string;

// #2208 fix-round F2.
export function firstNonEmptyLine(code: string): string | null;
// #2208 fix-round F6: maxLine clamps the scraped gutter numbers.
export function buildScrapeExpr(
	sentinelB64: string | null,
	maxLine?: number,
): string;

// #2306.
export interface ScrapeResult {
	found: boolean;
	sentinelFound: boolean;
	sourceLen?: number;
}

export interface PollStability {
	stableUnmatchedPolls: number;
	lastUnmatchedSourceLen: number | null;
	concludedEarly: boolean;
}

export const initialPollStability: PollStability;
export function trackStableUnmatched(
	scrape: ScrapeResult | null,
	prevState: PollStability,
): PollStability;
