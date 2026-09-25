// Type declarations for rekey-hook-await-exemptions.mjs (untyped .mjs
// imported from tests/scripts/rekey-hook-await-exemptions.test.ts —
// #2530 round 4 F2).

/** One live occurrence, as `scanFiles` (tests/support/hook-await-scan.ts) produces it. */
export interface RekeyOccurrence {
	key: string;
	detail: string;
}

/** An old table key that could not be matched to exactly one live occurrence. */
export interface UnresolvedRekeyEntry {
	oldKey: string;
	candidates: string[];
	reason: string;
}

export interface RekeyPlan {
	oldKeyCount: number;
	newKeyCount: number;
	mapping: Map<string, string>;
	unresolved: UnresolvedRekeyEntry[];
	changed: [string, string][];
	scanKeysAbsentFromTable: number;
}

export function parseOldKeys(source: string): string[];

export function headOf(key: string): string;

export function buildRekeyPlan(
	oldKeys: readonly string[],
	newOccurrences: readonly RekeyOccurrence[],
): RekeyPlan;

export function applyPlan(
	source: string,
	plan: RekeyPlan,
	write: boolean,
): void;
