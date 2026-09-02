/**
 * Centralized accessor for `@earendil-works/pi-tui`, routed through here for a
 * uniform dep surface. pi-tui is a pi-bundled core package: the host resolves
 * the bare specifier from its own runtime, so pi-lens declares it as an OPTIONAL
 * peer plus a devDependency and never as a runtime dependency. A runtime
 * dependency makes `npm install --omit=dev` vendor a private second copy that
 * Node evaluates at import — ~97ms of the 838ms git-install module import in
 * #1926. `scripts/lib/host-provided-deps.mjs` holds the list, and
 * `tests/packaging.test.ts` pins the declaration.
 *
 * Re-export named bindings, not `export *`: with the package kept external, a
 * wildcard re-export leaves the namespace undefined at runtime under the bundle.
 */

export type { Component } from "@earendil-works/pi-tui";
export { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
