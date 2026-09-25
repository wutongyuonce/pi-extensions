import type { FsReadRestrictionConfig, FsWriteRestrictionConfig } from './sandbox-schemas.js';
import type { IgnoreViolationsConfig } from './sandbox-config.js';
export interface MacOSSandboxParams {
    command: string;
    needsNetworkRestriction: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    allowLocalBinding?: boolean;
    readConfig: FsReadRestrictionConfig | undefined;
    writeConfig: FsWriteRestrictionConfig | undefined;
    ignoreViolations?: IgnoreViolationsConfig | undefined;
    allowPty?: boolean;
    allowGitConfig?: boolean;
    binShell?: string;
}
/**
 * Get mandatory deny patterns as glob patterns (no filesystem scanning).
 * macOS sandbox profile supports regex/glob matching directly via globToRegex().
 */
export declare function macGetMandatoryDenyPatterns(allowGitConfig?: boolean): string[];
export interface SandboxViolationEvent {
    line: string;
    command?: string;
    encodedCommand?: string;
    timestamp: Date;
}
export type SandboxViolationCallback = (violation: SandboxViolationEvent) => void;
/**
 * Convert a glob pattern to a regular expression for macOS sandbox profiles
 *
 * This implements gitignore-style pattern matching to match the behavior of the
 * `ignore` library used by the permission system/
 *
 * Supported patterns:
 * - * matches any characters except / (e.g., *.ts matches foo.ts but not foo/bar.ts)
 * - ** matches any characters including / (e.g., src/** /*.ts matches all .ts files in src/)
 * - ? matches any single character except / (e.g., file?.txt matches file1.txt)
 * - [abc] matches any character in the set (e.g., file[0-9].txt matches file3.txt)
 *
 * Note: This is designed for macOS sandbox (regex ...) syntax. The resulting regex
 * will be used in sandbox profiles like: (deny file-write* (regex "pattern"))
 *
 * Exported for testing purposes.
 */
export declare function globToRegex(globPattern: string): string;
/**
 * Wrap command with macOS sandbox
 */
export declare function wrapCommandWithSandboxMacOS(params: MacOSSandboxParams): string;
/**
 * Start monitoring macOS system logs for sandbox violations
 * Look for sandbox-related kernel deny events ending in {logTag}
 */
export declare function startMacOSSandboxLogMonitor(callback: SandboxViolationCallback, ignoreViolations?: IgnoreViolationsConfig): () => void;
//# sourceMappingURL=macos-sandbox-utils.d.ts.map