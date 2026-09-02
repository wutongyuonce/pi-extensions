/**
 * Re-export from shared path-utils.
 * Kept as a local module for LSP imports that use relative paths.
 */
export {
	isUnderDir,
	normalizeFilePath,
	normalizeEphemeralMapKey,
	normalizeMapKey,
	pathsEqual,
	pathToUri,
	uriToDiskPath,
	uriToPath,
} from "../path-utils.js";
