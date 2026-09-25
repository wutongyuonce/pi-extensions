export const SCRATCH_DIR_ROOT: string;
export const SCRATCH_OWNER_FILE: string;
/** `maxAgeMs` meaning "no age condition"; see the .mjs for why not `0`. */
export const SWEEP_ANY_AGE: number;
export function claimScratchDir(root: string, prefix: string): string;
export function sweepScratchDirs(
	root: string,
	prefix: string,
	options?: { maxAgeMs?: number },
): number;
