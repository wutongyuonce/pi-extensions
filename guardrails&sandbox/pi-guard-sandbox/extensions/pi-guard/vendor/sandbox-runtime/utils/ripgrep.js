import { spawnSync } from 'child_process';
import { execFile } from 'child_process';
/**
 * Check if ripgrep (rg) is available synchronously
 * Returns true if rg is installed, false otherwise
 */
export function hasRipgrepSync() {
    try {
        const result = spawnSync('which', ['rg'], {
            stdio: 'ignore',
            timeout: 1000,
        });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
/**
 * Execute ripgrep with the given arguments
 * @param args Command-line arguments to pass to rg
 * @param target Target directory or file to search
 * @param abortSignal AbortSignal to cancel the operation
 * @param config Ripgrep configuration (command and optional args)
 * @returns Array of matching lines (one per line of output)
 * @throws Error if ripgrep exits with non-zero status (except exit code 1 which means no matches)
 */
export async function ripGrep(args, target, abortSignal, config = { command: 'rg' }) {
    const { command, args: commandArgs = [] } = config;
    return new Promise((resolve, reject) => {
        execFile(command, [...commandArgs, ...args, target], {
            maxBuffer: 20000000, // 20MB
            signal: abortSignal,
            timeout: 10000, // 10 second timeout
        }, (error, stdout, stderr) => {
            // Success case - exit code 0
            if (!error) {
                resolve(stdout.trim().split('\n').filter(Boolean));
                return;
            }
            // Exit code 1 means "no matches found" - this is normal, return empty array
            if (error.code === 1) {
                resolve([]);
                return;
            }
            // All other errors should fail
            reject(new Error(`ripgrep failed with exit code ${error.code}: ${stderr || error.message}`));
        });
    });
}
//# sourceMappingURL=ripgrep.js.map