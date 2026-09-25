/**
 * Configuration for Sandbox Runtime
 * This is the main configuration interface that consumers pass to SandboxManager.initialize()
 */
import { z } from 'zod';
/**
 * Network configuration schema for validation
 */
export declare const NetworkConfigSchema: z.ZodObject<{
    allowedDomains: z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">;
    deniedDomains: z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">;
    allowUnixSockets: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    allowAllUnixSockets: z.ZodOptional<z.ZodBoolean>;
    allowLocalBinding: z.ZodOptional<z.ZodBoolean>;
    httpProxyPort: z.ZodOptional<z.ZodNumber>;
    socksProxyPort: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets?: string[] | undefined;
    allowAllUnixSockets?: boolean | undefined;
    allowLocalBinding?: boolean | undefined;
    httpProxyPort?: number | undefined;
    socksProxyPort?: number | undefined;
}, {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets?: string[] | undefined;
    allowAllUnixSockets?: boolean | undefined;
    allowLocalBinding?: boolean | undefined;
    httpProxyPort?: number | undefined;
    socksProxyPort?: number | undefined;
}>;
/**
 * Filesystem configuration schema for validation
 */
export declare const FilesystemConfigSchema: z.ZodObject<{
    denyRead: z.ZodArray<z.ZodString, "many">;
    allowWrite: z.ZodArray<z.ZodString, "many">;
    denyWrite: z.ZodArray<z.ZodString, "many">;
    allowGitConfig: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    allowGitConfig?: boolean | undefined;
}, {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    allowGitConfig?: boolean | undefined;
}>;
/**
 * Configuration schema for ignoring specific sandbox violations
 * Maps command patterns to filesystem paths to ignore violations for.
 */
export declare const IgnoreViolationsConfigSchema: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString, "many">>;
/**
 * Ripgrep configuration schema
 */
export declare const RipgrepConfigSchema: z.ZodObject<{
    command: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    command: string;
    args?: string[] | undefined;
}, {
    command: string;
    args?: string[] | undefined;
}>;
/**
 * Seccomp configuration schema (Linux only)
 * Allows specifying custom paths to seccomp binaries
 */
export declare const SeccompConfigSchema: z.ZodObject<{
    bpfPath: z.ZodOptional<z.ZodString>;
    applyPath: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    bpfPath?: string | undefined;
    applyPath?: string | undefined;
}, {
    bpfPath?: string | undefined;
    applyPath?: string | undefined;
}>;
/**
 * Main configuration schema for Sandbox Runtime validation
 */
export declare const SandboxRuntimeConfigSchema: z.ZodObject<{
    network: z.ZodObject<{
        allowedDomains: z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">;
        deniedDomains: z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">;
        allowUnixSockets: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowAllUnixSockets: z.ZodOptional<z.ZodBoolean>;
        allowLocalBinding: z.ZodOptional<z.ZodBoolean>;
        httpProxyPort: z.ZodOptional<z.ZodNumber>;
        socksProxyPort: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        allowedDomains: string[];
        deniedDomains: string[];
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        httpProxyPort?: number | undefined;
        socksProxyPort?: number | undefined;
    }, {
        allowedDomains: string[];
        deniedDomains: string[];
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        httpProxyPort?: number | undefined;
        socksProxyPort?: number | undefined;
    }>;
    filesystem: z.ZodObject<{
        denyRead: z.ZodArray<z.ZodString, "many">;
        allowWrite: z.ZodArray<z.ZodString, "many">;
        denyWrite: z.ZodArray<z.ZodString, "many">;
        allowGitConfig: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
        allowGitConfig?: boolean | undefined;
    }, {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
        allowGitConfig?: boolean | undefined;
    }>;
    ignoreViolations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString, "many">>>;
    enableWeakerNestedSandbox: z.ZodOptional<z.ZodBoolean>;
    ripgrep: z.ZodOptional<z.ZodObject<{
        command: z.ZodString;
        args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        command: string;
        args?: string[] | undefined;
    }, {
        command: string;
        args?: string[] | undefined;
    }>>;
    mandatoryDenySearchDepth: z.ZodOptional<z.ZodNumber>;
    allowPty: z.ZodOptional<z.ZodBoolean>;
    seccomp: z.ZodOptional<z.ZodObject<{
        bpfPath: z.ZodOptional<z.ZodString>;
        applyPath: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        bpfPath?: string | undefined;
        applyPath?: string | undefined;
    }, {
        bpfPath?: string | undefined;
        applyPath?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    network: {
        allowedDomains: string[];
        deniedDomains: string[];
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        httpProxyPort?: number | undefined;
        socksProxyPort?: number | undefined;
    };
    filesystem: {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
        allowGitConfig?: boolean | undefined;
    };
    ignoreViolations?: Record<string, string[]> | undefined;
    enableWeakerNestedSandbox?: boolean | undefined;
    ripgrep?: {
        command: string;
        args?: string[] | undefined;
    } | undefined;
    mandatoryDenySearchDepth?: number | undefined;
    allowPty?: boolean | undefined;
    seccomp?: {
        bpfPath?: string | undefined;
        applyPath?: string | undefined;
    } | undefined;
}, {
    network: {
        allowedDomains: string[];
        deniedDomains: string[];
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        httpProxyPort?: number | undefined;
        socksProxyPort?: number | undefined;
    };
    filesystem: {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
        allowGitConfig?: boolean | undefined;
    };
    ignoreViolations?: Record<string, string[]> | undefined;
    enableWeakerNestedSandbox?: boolean | undefined;
    ripgrep?: {
        command: string;
        args?: string[] | undefined;
    } | undefined;
    mandatoryDenySearchDepth?: number | undefined;
    allowPty?: boolean | undefined;
    seccomp?: {
        bpfPath?: string | undefined;
        applyPath?: string | undefined;
    } | undefined;
}>;
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
export type FilesystemConfig = z.infer<typeof FilesystemConfigSchema>;
export type IgnoreViolationsConfig = z.infer<typeof IgnoreViolationsConfigSchema>;
export type RipgrepConfig = z.infer<typeof RipgrepConfigSchema>;
export type SeccompConfig = z.infer<typeof SeccompConfigSchema>;
export type SandboxRuntimeConfig = z.infer<typeof SandboxRuntimeConfigSchema>;
//# sourceMappingURL=sandbox-config.d.ts.map