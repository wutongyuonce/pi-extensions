export interface Win32Gate {
	file: string;
	line: number;
}

export interface WindowsLaneAdmission {
	file: string;
	reason: string;
}

export declare const WINDOWS_LANE_ADMISSIONS: readonly WindowsLaneAdmission[];

/** Per-fork cap on remembered vanished paths; see the TypeScript seam's twin
 *  in tests/support/sweep-kit.ts for why it is bounded. */
export declare const VANISHED_PATH_RECORD_CAP: number;
/** Tolerant read for a path this module's own walk produced (#3082); warns
 *  once per distinct path and returns undefined when the file has vanished. */
export declare function readWalkedFile(absolute: string): string | undefined;
/** Test seam: the cap is only observable through many recorded paths. */
export declare function recordedVanishedPathCount(): number;
export declare function findWin32Gates(cwd?: string): Win32Gate[];
export declare function getWin32GateFiles(cwd?: string): string[];
export declare function getWin32LaneFiles(cwd?: string): string[];
