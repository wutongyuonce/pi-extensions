/**
 * TypeScript-facing entry for the shared hook-await scan.
 *
 * The implementation is JavaScript so maintenance scripts can load the same
 * seam without depending on Node's optional built-in TypeScript support.
 */
export * from "./hook-await-scan.mjs";
