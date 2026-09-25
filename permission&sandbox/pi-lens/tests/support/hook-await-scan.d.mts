export const DEFINITION_FILE: string;
export function findUnboundedAwaitLines(stripped: string): number[];
export function findHandRolledRaceLines(stripped: string): number[];
export function findBoundedCallLines(stripped: string): number[];
export function awaitOccurrenceKey(
	rel: string,
	rawLines: readonly string[],
	index: number,
): string;
export function hookPathFiles(repoRoot: string): string[];
export function localImportTargets(absolute: string): string[];
export function hookHelperModules(repoRoot: string): string[];
export function shippedSourceFiles(repoRoot: string): string[];
export interface FlaggedSite {
	key: string;
	detail: string;
}
export function scanFiles(
	repoRoot: string,
	files: readonly string[],
	detect: (stripped: string) => number[],
	prefix: string,
	skipRel?: (rel: string) => boolean,
): { occurrences: FlaggedSite[]; scanned: number };
