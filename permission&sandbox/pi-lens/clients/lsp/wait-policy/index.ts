/**
 * Incumbent-owned LSP wait policy and capability inventory boundary (#822).
 *
 * The incumbent applies this policy when it serves attached sessions. Keep
 * this boundary process-neutral and free of session-local state: do not import
 * runtime-session, runtime-turn, or warm-attach here.
 */

export * from "./capability-snapshot.js";
export * from "./classification.js";
export * from "./strategies.js";
