export declare const DEFAULT_MAX_FILES: 6;
export declare const MUTATION_BUDGET_MINUTES: 60;
export declare function capMutationFiles(
	files: string[],
	maxFiles?: number,
): { selected: string[]; skipped: string[] };
export declare function formatCapNotice(
	selectedCount: number,
	totalCount: number,
	skipped: string[],
): string;
export declare const isScriptMutationFile: (file: string) => boolean;
export declare function mapRelatedTests(
	changedFiles: string[],
	options?: {
		testFiles?: string[];
		readFile?: (file: string) => string;
	},
): {
	related: Map<string, Set<string>>;
	covered: string[];
	uncovered: string[];
	tests: string[];
};
export declare function parseChangedLineRanges(
	diffText: string,
): Map<string, Array<[number, number]>>;
export declare function mutationRangePatterns(
	files: string[],
	rangesByFile: Map<string, Array<[number, number]>>,
): string[];
export declare function describeStrykerFailure(
	result: {
		status: number | null;
		signal?: NodeJS.Signals | null;
		error?: Error & { code?: string };
	},
	budgetMinutes: number,
): string;
