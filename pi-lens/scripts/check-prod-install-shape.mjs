#!/usr/bin/env node
/**
 * Assert a production install (`npm install --omit=dev`) did NOT vendor any
 * host-provided package into node_modules. #1926.
 *
 * pi provides `typebox`, `@earendil-works/pi-tui`, and
 * `@earendil-works/pi-coding-agent` from its own runtime. If one of them slips
 * back into `dependencies` — or loses `peerDependenciesMeta.optional`, which
 * makes npm install the peer anyway — the git install gets a private second
 * copy. Node then resolves the bare specifier to that copy and evaluates a whole
 * extra module graph at extension load: 941ms instead of ~180ms in the PI_TIMING
 * capture on #1926.
 *
 * The packaging test pins the DECLARATION. This pins the INSTALLED RESULT, which
 * is what users actually get, and it runs in the CI job that simulates the real
 * `pi install git:…` path.
 *
 * USAGE
 *   node scripts/check-prod-install-shape.mjs            # check ./node_modules
 *   node scripts/check-prod-install-shape.mjs <root>     # check <root>/node_modules
 *
 * Exits 1 and names every vendored package on failure.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PROVIDED_PACKAGES } from "./lib/host-provided-deps.mjs";

const scriptRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const root = path.resolve(process.argv[2] ?? scriptRoot);
const modules = path.join(root, "node_modules");

if (!existsSync(modules)) {
	console.error(
		`[install-shape] ${modules} not found — run npm install first.`,
	);
	process.exit(1);
}

const vendored = HOST_PROVIDED_PACKAGES.filter((name) =>
	existsSync(path.join(modules, ...name.split("/"))),
);

// A development tree installs devDependencies, and the host-provided packages
// ARE devDependencies, so they are present and SHOULD be. Say so instead of
// reporting a failure a developer cannot act on. Detect the tree by a
// devDependency nothing else installs.
const looksLikeDevTree = existsSync(path.join(modules, "vitest"));

if (vendored.length > 0) {
	if (looksLikeDevTree) {
		console.error(
			"[install-shape] SKIPPED: this looks like a development install " +
				"(node_modules/vitest is present), where the host-provided packages " +
				"are expected as devDependencies. This check targets a PRODUCTION " +
				"install — `npm install --omit=dev`, or a packed tarball — which is " +
				"what CI runs it against (#1926).",
		);
		process.exit(0);
	}
	console.error(
		"[install-shape] FAILED: a production install vendored host-provided " +
			"package(s), which pi already supplies:",
	);
	for (const name of vendored) {
		console.error(`  - ${name}`);
	}
	console.error(
		"Each vendored copy is a second module graph the extension evaluates at " +
			"load (#1926). Declare it as an OPTIONAL peerDependency plus a " +
			"devDependency, never as a runtime dependency.",
	);
	process.exit(1);
}

console.error(
	`[install-shape] OK: none of ${HOST_PROVIDED_PACKAGES.join(", ")} vendored ` +
		`under ${path.relative(process.cwd(), modules) || "node_modules"}.`,
);
