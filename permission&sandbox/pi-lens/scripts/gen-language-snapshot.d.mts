export declare const SNAPSHOT_PATH: string;
export declare function extensionUnion(): string[];
export declare function describe(
	samplePath: string,
): Record<string, string | null>;
export declare function buildSnapshot(): {
	note: string;
	grammars: string[];
	files: Record<string, Record<string, string | null>>;
};
