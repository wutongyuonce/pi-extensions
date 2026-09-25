export declare const SNAPSHOT_PATH: string;
export declare function findCargoManifestDirs(root: string): string[];
export declare function buildSnapshot(): {
	note: string;
	byDir: Record<
		string,
		{
			modules: Array<{
				name: string;
				relativePath: string;
				entrypoints: string[];
				internalDeps: string[];
				externalDeps: string[];
			}>;
			dependents: Record<string, string[]>;
		} | null
	>;
};
