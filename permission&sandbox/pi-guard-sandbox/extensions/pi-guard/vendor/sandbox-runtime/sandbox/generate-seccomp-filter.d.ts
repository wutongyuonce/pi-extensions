/**
 * Get the path to a pre-generated BPF filter file from the vendor directory
 * Returns the path if it exists, null otherwise
 *
 * Pre-generated BPF files are organized by architecture:
 * - vendor/seccomp/{x64,arm64}/unix-block.bpf
 *
 * Tries multiple paths for resilience:
 * 0. Expected path provided via parameter (checked first if provided)
 * 1. vendor/seccomp/{arch}/unix-block.bpf (bundled - when bundled into consuming packages)
 * 2. ../../vendor/seccomp/{arch}/unix-block.bpf (package root - standard npm installs)
 * 3. ../vendor/seccomp/{arch}/unix-block.bpf (dist/vendor - for bundlers)
 *
 * @param expectedPath - Optional path to check first (highest priority)
 */
export declare function getPreGeneratedBpfPath(expectedPath?: string): string | null;
/**
 * Get the path to the apply-seccomp binary from the vendor directory
 * Returns the path if it exists, null otherwise
 *
 * Pre-built apply-seccomp binaries are organized by architecture:
 * - vendor/seccomp/{x64,arm64}/apply-seccomp
 *
 * Tries multiple paths for resilience:
 * 0. Expected path provided via parameter (checked first if provided)
 * 1. vendor/seccomp/{arch}/apply-seccomp (bundled - when bundled into consuming packages)
 * 2. ../../vendor/seccomp/{arch}/apply-seccomp (package root - standard npm installs)
 * 3. ../vendor/seccomp/{arch}/apply-seccomp (dist/vendor - for bundlers)
 *
 * @param expectedPath - Optional path to check first (highest priority)
 */
export declare function getApplySeccompBinaryPath(expectedPath?: string): string | null;
/**
 * Get the path to a pre-generated seccomp BPF filter that blocks Unix domain socket creation
 * Returns the path to the BPF filter file, or null if not available
 *
 * The filter blocks socket(AF_UNIX, ...) syscalls while allowing all other syscalls.
 * This prevents creation of new Unix domain socket file descriptors.
 *
 * Security scope:
 * - Blocks: socket(AF_UNIX, ...) syscall (creating new Unix socket FDs)
 * - Does NOT block: Operations on inherited Unix socket FDs (bind, connect, sendto, etc.)
 * - Does NOT block: Unix socket FDs passed via SCM_RIGHTS
 * - For most sandboxing scenarios, blocking socket creation is sufficient
 *
 * Note: This blocks ALL Unix socket creation, regardless of path. The allowUnixSockets
 * configuration is not supported on Linux due to seccomp-bpf limitations (it cannot
 * read user-space memory to inspect socket paths).
 *
 * Requirements:
 * - Pre-generated BPF filters included for x64 and ARM64 only
 * - Other architectures are not supported
 *
 * @param expectedPath - Optional path to check first (highest priority)
 * @returns Path to the pre-generated BPF filter file, or null if not available
 */
export declare function generateSeccompFilter(expectedPath?: string): string | null;
/**
 * Clean up a seccomp filter file
 * Since we only use pre-generated BPF files from vendor/, this is a no-op.
 * Pre-generated files are never deleted.
 * Kept for backward compatibility with existing code that calls it.
 */
export declare function cleanupSeccompFilter(_filterPath: string): void;
//# sourceMappingURL=generate-seccomp-filter.d.ts.map