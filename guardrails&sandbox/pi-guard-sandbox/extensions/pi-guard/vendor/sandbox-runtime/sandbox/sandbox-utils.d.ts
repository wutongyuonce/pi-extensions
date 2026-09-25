/**
 * Dangerous files that should be protected from writes.
 * These files can be used for code execution or data exfiltration.
 */
export declare const DANGEROUS_FILES: readonly [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json"];
/**
 * Dangerous directories that should be protected from writes.
 * These directories contain sensitive configuration or executable files.
 */
export declare const DANGEROUS_DIRECTORIES: readonly [".git", ".vscode", ".idea"];
/**
 * Get the list of dangerous directories to deny writes to.
 * Excludes .git since we need it writable for git operations -
 * instead we block specific paths within .git (hooks and config).
 */
export declare function getDangerousDirectories(): string[];
/**
 * Normalizes a path for case-insensitive comparison.
 * This prevents bypassing security checks using mixed-case paths on case-insensitive
 * filesystems (macOS/Windows) like `.cLauDe/Settings.locaL.json`.
 *
 * We always normalize to lowercase regardless of platform for consistent security.
 * @param path The path to normalize
 * @returns The lowercase path for safe comparison
 */
export declare function normalizeCaseForComparison(pathStr: string): string;
/**
 * Check if a path pattern contains glob characters
 */
export declare function containsGlobChars(pathPattern: string): boolean;
/**
 * Remove trailing /** glob suffix from a path pattern
 * Used to normalize path patterns since /** just means "directory and everything under it"
 */
export declare function removeTrailingGlobSuffix(pathPattern: string): string;
/**
 * Check if a symlink resolution crosses expected path boundaries.
 *
 * When resolving symlinks for sandbox path normalization, we need to ensure
 * the resolved path doesn't unexpectedly broaden the scope. This function
 * returns true if the resolved path is an ancestor of the original path
 * or resolves to a system root, which would indicate the symlink points
 * outside expected boundaries.
 *
 * @param originalPath - The original path before symlink resolution
 * @param resolvedPath - The path after fs.realpathSync() resolution
 * @returns true if the resolved path is outside expected boundaries
 */
export declare function isSymlinkOutsideBoundary(originalPath: string, resolvedPath: string): boolean;
/**
 * Normalize a path for use in sandbox configurations
 * Handles:
 * - Tilde (~) expansion for home directory
 * - Relative paths (./foo, ../foo, etc.) converted to absolute
 * - Absolute paths remain unchanged
 * - Symlinks are resolved to their real paths for non-glob patterns
 * - Glob patterns preserve wildcards after path normalization
 *
 * Returns the absolute path with symlinks resolved (or normalized glob pattern)
 */
export declare function normalizePathForSandbox(pathPattern: string): string;
/**
 * Get recommended system paths that should be writable for commands to work properly
 *
 * WARNING: These default paths are intentionally broad for compatibility but may
 * allow access to files from other processes. In highly security-sensitive
 * environments, you should configure more restrictive write paths.
 */
export declare function getDefaultWritePaths(): string[];
/**
 * Generate proxy environment variables for sandboxed processes
 */
export declare function generateProxyEnvVars(httpProxyPort?: number, socksProxyPort?: number): string[];
/**
 * Encode a command for sandbox monitoring
 * Truncates to 100 chars and base64 encodes to avoid parsing issues
 */
export declare function encodeSandboxedCommand(command: string): string;
/**
 * Decode a base64-encoded command from sandbox monitoring
 */
export declare function decodeSandboxedCommand(encodedCommand: string): string;
//# sourceMappingURL=sandbox-utils.d.ts.map