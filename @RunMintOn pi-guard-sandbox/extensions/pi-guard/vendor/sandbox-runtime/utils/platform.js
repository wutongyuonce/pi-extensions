/**
 * Platform detection utilities
 */
export function getPlatform() {
    switch (process.platform) {
        case 'darwin':
            return 'macos';
        case 'linux':
            return 'linux';
        case 'win32':
            return 'windows';
        default:
            return 'unknown';
    }
}
//# sourceMappingURL=platform.js.map