export declare function jitiHash(text: string, length?: number): string;

export declare function expectedCacheFileName(entry: string): string;

export declare function verifyCacheEntry(args: {
	cacheDir: string;
	fileName: string;
	source: string;
	fsDeps: {
		existsSync: (p: string) => boolean;
		readFileSync: (p: string) => string;
		isWritable: (p: string) => boolean;
	};
}): { ok: boolean; reason: string | null; transformVersion: string | null };

export declare function resolveJitiCacheDir(deps: {
	tmpdir: () => string;
	env: Record<string, string | undefined>;
	cwd: () => string;
	join: (a: string, b: string) => string;
}): string;

export declare function buildStubAliases(
	hostProvidedPackages: readonly string[],
): Record<string, string>;

export declare const STUB_TARGET: string;

export declare function warmSkipReason(state: {
	env: Record<string, string | undefined>;
	distEntryExists: boolean;
	jitiResolvable: boolean;
}): string | null;

export declare function appendBounded(
	existingLines: string[],
	line: string,
	max?: number,
): string[];

export declare const INSTALL_LOG_MAX_LINES: number;
