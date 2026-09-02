import type { ChildProcess } from 'node:child_process';
import type { FsReadRestrictionConfig, FsWriteRestrictionConfig } from './sandbox-schemas.js';
export interface LinuxNetworkBridgeContext {
    httpSocketPath: string;
    socksSocketPath: string;
    httpBridgeProcess: ChildProcess;
    socksBridgeProcess: ChildProcess;
    httpProxyPort: number;
    socksProxyPort: number;
}
export interface LinuxSandboxParams {
    command: string;
    needsNetworkRestriction: boolean;
    httpSocketPath?: string;
    socksSocketPath?: string;
    httpProxyPort?: number;
    socksProxyPort?: number;
    readConfig?: FsReadRestrictionConfig;
    writeConfig?: FsWriteRestrictionConfig;
    enableWeakerNestedSandbox?: boolean;
    allowAllUnixSockets?: boolean;
    binShell?: string;
    ripgrepConfig?: {
        command: string;
        args?: string[];
    };
    /** Maximum directory depth to search for dangerous files (default: 3) */
    mandatoryDenySearchDepth?: number;
    /** Allow writes to .git/config files (default: false) */
    allowGitConfig?: boolean;
    /** Custom seccomp binary paths */
    seccompConfig?: {
        bpfPath?: string;
        applyPath?: string;
    };
    /** Abort signal to cancel the ripgrep scan */
    abortSignal?: AbortSignal;
}
/**
 * Check if Linux sandbox dependencies are available (synchronous)
 * Returns true if bwrap and socat are installed.
 */
export declare function hasLinuxSandboxDependenciesSync(allowAllUnixSockets?: boolean, seccompConfig?: {
    bpfPath?: string;
    applyPath?: string;
}): boolean;
/**
 * Initialize the Linux network bridge for sandbox networking
 *
 * ARCHITECTURE NOTE:
 * Linux network sandboxing uses bwrap --unshare-net which creates a completely isolated
 * network namespace with NO network access. To enable network access, we:
 *
 * 1. Host side: Run socat bridges that listen on Unix sockets and forward to host proxy servers
 *    - HTTP bridge: Unix socket -> host HTTP proxy (for HTTP/HTTPS traffic)
 *    - SOCKS bridge: Unix socket -> host SOCKS5 proxy (for SSH/git traffic)
 *
 * 2. Sandbox side: Bind the Unix sockets into the isolated namespace and run socat listeners
 *    - HTTP listener on port 3128 -> HTTP Unix socket -> host HTTP proxy
 *    - SOCKS listener on port 1080 -> SOCKS Unix socket -> host SOCKS5 proxy
 *
 * 3. Configure environment:
 *    - HTTP_PROXY=http://localhost:3128 for HTTP/HTTPS tools
 *    - GIT_SSH_COMMAND with socat for SSH through SOCKS5
 *
 * LIMITATION: Unlike macOS sandbox which can enforce domain-based allowlists at the kernel level,
 * Linux's --unshare-net provides only all-or-nothing network isolation. Domain filtering happens
 * at the host proxy level, not the sandbox boundary. This means network restrictions on Linux
 * depend on the proxy's filtering capabilities.
 *
 * DEPENDENCIES: Requires bwrap (bubblewrap) and socat
 */
export declare function initializeLinuxNetworkBridge(httpProxyPort: number, socksProxyPort: number): Promise<LinuxNetworkBridgeContext>;
/**
 * Wrap a command with sandbox restrictions on Linux
 *
 * UNIX SOCKET BLOCKING (APPLY-SECCOMP):
 * This implementation uses a custom apply-seccomp binary to block Unix domain socket
 * creation for user commands while allowing network infrastructure:
 *
 * Stage 1: Outer bwrap - Network and filesystem isolation (NO seccomp)
 *   - Bubblewrap starts with isolated network namespace (--unshare-net)
 *   - Bubblewrap applies PID namespace isolation (--unshare-pid and --proc)
 *   - Filesystem restrictions are applied (read-only mounts, bind mounts, etc.)
 *   - Socat processes start and connect to Unix socket bridges (can use socket(AF_UNIX, ...))
 *
 * Stage 2: apply-seccomp - Seccomp filter application (ONLY seccomp)
 *   - apply-seccomp binary applies seccomp filter via prctl(PR_SET_SECCOMP)
 *   - Sets PR_SET_NO_NEW_PRIVS to allow seccomp without root
 *   - Execs user command with seccomp active (cannot create new Unix sockets)
 *
 * This solves the conflict between:
 * - Security: Blocking arbitrary Unix socket creation in user commands
 * - Functionality: Network sandboxing requires socat to call socket(AF_UNIX, ...) for bridge connections
 *
 * The seccomp-bpf filter blocks socket(AF_UNIX, ...) syscalls, preventing:
 * - Creating new Unix domain socket file descriptors
 *
 * Security limitations:
 * - Does NOT block operations (bind, connect, sendto, etc.) on inherited Unix socket FDs
 * - Does NOT prevent passing Unix socket FDs via SCM_RIGHTS
 * - For most sandboxing use cases, blocking socket creation is sufficient
 *
 * The filter allows:
 * - All TCP/UDP sockets (AF_INET, AF_INET6) for normal network operations
 * - All other syscalls
 *
 * PLATFORM NOTE:
 * The allowUnixSockets configuration is not path-based on Linux (unlike macOS)
 * because seccomp-bpf cannot inspect user-space memory to read socket paths.
 *
 * Requirements for seccomp filtering:
 * - Pre-built apply-seccomp binaries are included for x64 and ARM64
 * - Pre-generated BPF filters are included for x64 and ARM64
 * - Other architectures are not currently supported (no apply-seccomp binary available)
 * - To use sandboxing without Unix socket blocking on unsupported architectures,
 *   set allowAllUnixSockets: true in your configuration
 * Dependencies are checked by hasLinuxSandboxDependenciesSync() before enabling the sandbox.
 */
export declare function wrapCommandWithSandboxLinux(params: LinuxSandboxParams): Promise<string>;
//# sourceMappingURL=linux-sandbox-utils.d.ts.map