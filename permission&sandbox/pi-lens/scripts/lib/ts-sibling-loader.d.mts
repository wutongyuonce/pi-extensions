// Type declarations for ts-sibling-loader.mjs (a node:module customization
// hook; untyped .mjs, no consumer imports it for its exports today, but
// every other scripts/lib module carries a sibling .d.mts — #2530 round 4
// F2).

export interface ResolveContext {
	parentURL?: string;
	conditions?: string[];
	importAttributes?: Record<string, string>;
}

export interface ResolveResult {
	url: string;
	format?: string | null;
	shortCircuit?: boolean;
}

export type NextResolve = (
	specifier: string,
	context: ResolveContext,
) => ResolveResult | Promise<ResolveResult>;

export function resolve(
	specifier: string,
	context: ResolveContext,
	nextResolve: NextResolve,
): ResolveResult | Promise<ResolveResult>;
