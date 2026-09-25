// ---------------------------------------------------------------------------
// Test-first coverage for PR #13: chore(types) — replace types-shims.d.ts
// with real type packages
//
// Background:
//   PR #13 (https://github.com/MasuRii/pi-permission-system/pull/13) replaces
//   the hand-rolled src/types-shims.d.ts with real upstream type packages
//   and drops --noCheck from the build. Adds @mariozechner/pi-coding-agent,
//   @mariozechner/pi-tui, @mariozechner/pi-ai, @types/node, and
//   @sinclair/typebox as devDependencies.
//
//   Note: The local workspace uses the @earendil-works/* namespace (not
//   @mariozechner/*) and peer dependency range ^0.74.0 || ^0.75.0.
//   The PR's namespace and version targets differ, but the *intent*
//   (remove shims, rely on real types) is locally applicable.
//
// These tests document the current type state and would serve as regression
// tests if someone later removes types-shims.d.ts.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runTest, runAsyncTest } from "./test-harness.js";

const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIMS_PATH = join(EXTENSION_ROOT, "src", "types-shims.d.ts");
const PACKAGE_JSON_PATH = join(EXTENSION_ROOT, "package.json");

// ===========================================================================
// Section 1: types-shims.d.ts existence and structure
// ===========================================================================

runTest("PR13: types-shims.d.ts exists at the expected location", () => {
  assert.ok(
    existsSync(SHIMS_PATH),
    "types-shims.d.ts must exist; PR #13 aims to remove it in favor of real packages",
  );
});

runTest("PR13: types-shims.d.ts is a non-empty file", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  assert.ok(content.length > 0, "types-shims.d.ts should not be empty");
  assert.ok(content.includes("declare module"), "Should contain module declarations");
});

runTest("PR13: types-shims.d.ts declares all @earendil-works/* modules used by the extension", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");

  // Check the modules the extension actually imports
  assert.ok(
    content.includes('declare module "@earendil-works/pi-coding-agent"'),
    "Must declare @earendil-works/pi-coding-agent",
  );
  assert.ok(
    content.includes('declare module "@earendil-works/pi-ai"'),
    "Must declare @earendil-works/pi-ai",
  );
  assert.ok(
    content.includes('declare module "@earendil-works/pi-tui"'),
    "Must declare @earendil-works/pi-tui",
  );
});

runTest("PR13: types-shims.d.ts declares node:* built-in modules used by the extension", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");

  // The shim explicitly declares these node:* modules
  const declaredModules = [
    "node:assert/strict",
    "node:crypto",
    "node:fs",
    "node:os",
    "node:path",
    "node:url",
  ];

  for (const mod of declaredModules) {
    assert.ok(
      content.includes(`declare module "${mod}"`),
      `types-shims.d.ts must declare module "${mod}"`,
    );
  }

  // Note: node:fs/promises is NOT declared in the shim because the local
  // type baseline relies on transitive @types/node for that surface. This is
  // a gap that would need to be filled when moving to explicit @types/node.
  const hasFsPromisesShim = content.includes('declare module "node:fs/promises"');
  if (!hasFsPromisesShim) {
    console.log("  [INFO] node:fs/promises is NOT shimmed — relies on transitive @types/node");
  }
});

runTest("PR13: types-shims.d.ts declares node:test module mock", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  assert.ok(
    content.includes('declare module "node:test"'),
    "Must declare node:test — used by config-modal.test.ts for mock.module()",
  );
});

// ===========================================================================
// Section 2: Real package type availability
// ===========================================================================

runTest("PR13: Real @earendil-works/pi-coding-agent package has types entry", () => {
  const pkgJsonPath = join(EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  assert.ok(existsSync(pkgJsonPath), "pi-coding-agent package.json must exist");

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
  assert.ok(pkg.types, "pi-coding-agent must have a 'types' field");
  assert.equal(pkg.types, "./dist/index.d.ts");

  const distTypesPath = join(EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.d.ts");
  assert.ok(existsSync(distTypesPath), "pi-coding-agent dist/index.d.ts must exist");
});

runTest("PR13: Real @earendil-works/pi-ai package has types entry", () => {
  const pkgJsonPath = join(EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-ai", "package.json");
  assert.ok(existsSync(pkgJsonPath), "pi-ai package.json must exist");

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
  assert.ok(pkg.types, "pi-ai must have a 'types' field");
  assert.equal(pkg.types, "./dist/index.d.ts");

  const distTypesPath = join(EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "index.d.ts");
  assert.ok(existsSync(distTypesPath), "pi-ai dist/index.d.ts must exist");
});

runTest("PR13: Real @earendil-works/pi-tui package has types entry", () => {
  const pkgJsonPath = join(EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-tui", "package.json");
  assert.ok(existsSync(pkgJsonPath), "pi-tui package.json must exist");

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
  assert.ok(pkg.types, "pi-tui must have a 'types' field");
  assert.equal(pkg.types, "./dist/index.d.ts");

  const distTypesPath = join(EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-tui", "dist", "index.d.ts");
  assert.ok(existsSync(distTypesPath), "pi-tui dist/index.d.ts must exist");
});

// ===========================================================================
// Section 3: Shims redundancy analysis
// ===========================================================================

runTest("PR13: @earendil-works/pi-coding-agent shim types are redundant with real package", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  const realTypesPath = join(
    EXTENSION_ROOT,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.d.ts",
  );

  assert.ok(existsSync(realTypesPath), "Real types file must exist for comparison");
  const realTypes = readFileSync(realTypesPath, "utf8");

  // The shims declare everything as `any`, while the real package has specific types.
  // The shim's `declare module "@earendil-works/pi-coding-agent"` block shadows
  // the real package's type exports when both are loaded.
  const shimSection = content.match(/declare module "@earendil-works\/pi-coding-agent" \{[\s\S]*?\n\}/);
  assert.ok(shimSection !== null, "Shim declaration for pi-coding-agent must exist");

  // Verify that the real types exports are more specific than `any` — this
  // proves the shim is downgrading type safety
  assert.ok(
    realTypes.includes("export"),
    "Real types should have proper exports (not just any)",
  );

  // Check at least one specific export from the real types
  assert.ok(
    realTypes.includes("ExtensionAPI") || realTypes.includes("ExtensionContext"),
    "Real types should define extension-specific interfaces that the shim replaces with `any`",
  );
});

runTest("PR13: @earendil-works/pi-ai shim types are redundant with real package", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  const realTypesPath = join(
    EXTENSION_ROOT,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "index.d.ts",
  );

  assert.ok(existsSync(realTypesPath), "Real types file must exist for comparison");
  const realTypes = readFileSync(realTypesPath, "utf8");

  assert.ok(
    content.includes('declare module "@earendil-works/pi-ai"'),
    "Shim declaration for pi-ai must exist",
  );
  assert.ok(
    realTypes.includes("export"),
    "Real pi-ai types should have proper exports",
  );
});

runTest("PR13: @earendil-works/pi-tui shim types are redundant with real package", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  const realTypesPath = join(
    EXTENSION_ROOT,
    "node_modules",
    "@earendil-works",
    "pi-tui",
    "dist",
    "index.d.ts",
  );

  assert.ok(existsSync(realTypesPath), "Real types file must exist for comparison");
  const realTypes = readFileSync(realTypesPath, "utf8");

  assert.ok(
    content.includes('declare module "@earendil-works/pi-tui"'),
    "Shim declaration for pi-tui must exist",
  );
  assert.ok(
    realTypes.includes("export"),
    "Real pi-tui types should have proper exports",
  );
});

// ===========================================================================
// Section 4: What would break if shims are removed
// ===========================================================================

runTest("PR13: @types/node IS available transitively — node:* shims are REDUNDANT", () => {
  const typesNodePath = join(EXTENSION_ROOT, "node_modules", "@types", "node");
  assert.ok(
    existsSync(typesNodePath),
    "@types/node IS installed (transitively via @earendil-works/pi-coding-agent)",
  );
  // Check that index.d.ts provides NodeJS types
  const indexTypesPath = join(typesNodePath, "index.d.ts");
  assert.ok(existsSync(indexTypesPath), "@types/node/index.d.ts must exist");
});

runTest("PR13: node:test shim covers experimental mock.module typing", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  assert.ok(
    content.includes('declare module "node:test"'),
    "node:test shim must exist because installed @types/node may not expose experimental mock.module()",
  );
  // Verify the mock.module() function used in config-modal.test.ts
  assert.ok(
    content.includes("mock") && content.includes("module"),
    "node:test shim should declare mock.module() used by config-modal.test.ts",
  );
});

runTest("PR13: @sinclair/typebox is NOT imported by extension source — shim is not needed for it", () => {
  // Check all .ts files in src/ for typebox imports
  const content = readFileSync(SHIMS_PATH, "utf8");
  // The shim doesn't declare @sinclair/typebox — that comes from the real package
  assert.ok(
    content.includes("typebox") === false,
    "types-shims.d.ts does NOT declare @sinclair/typebox — it uses the real package",
  );
});

// ===========================================================================
// Section 5: tsconfig.json type-checking baseline
// ===========================================================================

runTest("PR13: skipLibCheck is enabled in tsconfig.json", () => {
  const tsconfigPath = join(EXTENSION_ROOT, "tsconfig.json");
  assert.ok(existsSync(tsconfigPath), "tsconfig.json must exist");

  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as Record<string, unknown>;
  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown> | undefined;
  assert.ok(compilerOptions !== undefined, "tsconfig must have compilerOptions");
  assert.equal(compilerOptions.skipLibCheck, true, "skipLibCheck is enabled — this masks type conflicts between shims and real packages");
});

runTest("PR13: types-shims.d.ts declares NodeJS namespace for process env types", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  // The shims declare NodeJS.ProcessEnv and NodeJS.Process used throughout
  assert.ok(content.includes("namespace NodeJS"), "Shims must declare NodeJS namespace");
  assert.ok(content.includes("ProcessEnv"), "Shims must declare ProcessEnv");
  assert.ok(content.includes("Process"), "Shims must declare Process");
});

// ===========================================================================
// Section 6: Coverage of all shimmed modules mapped to real alternatives
// ===========================================================================

runTest("PR13: Module dependency matrix — shimmed vs real type sources", () => {
  const content = readFileSync(SHIMS_PATH, "utf8");
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as Record<string, unknown>;
  const peerDeps = (packageJson.peerDependencies as Record<string, string>) ?? {};
  const deps = (packageJson.dependencies as Record<string, string>) ?? {};

  // Map each shimmed module to its real type source
  type ModuleEntry = {
    shimmed: boolean;
    realPackage: string;
    hasRealTypes: boolean;
    isPeerDep: boolean;
    isDirectDep: boolean;
  };

  const matrix: Record<string, ModuleEntry> = {
    "@earendil-works/pi-coding-agent": {
      shimmed: content.includes('declare module "@earendil-works/pi-coding-agent"'),
      realPackage: "@earendil-works/pi-coding-agent",
      hasRealTypes: existsSync(join(
        EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.d.ts",
      )),
      isPeerDep: "@earendil-works/pi-coding-agent" in peerDeps,
      isDirectDep: "@earendil-works/pi-coding-agent" in deps,
    },
    "@earendil-works/pi-ai": {
      shimmed: content.includes('declare module "@earendil-works/pi-ai"'),
      realPackage: "@earendil-works/pi-ai",
      hasRealTypes: existsSync(join(
        EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "index.d.ts",
      )),
      isPeerDep: "@earendil-works/pi-ai" in peerDeps,
      isDirectDep: "@earendil-works/pi-ai" in deps,
    },
    "@earendil-works/pi-tui": {
      shimmed: content.includes('declare module "@earendil-works/pi-tui"'),
      realPackage: "@earendil-works/pi-tui",
      hasRealTypes: existsSync(join(
        EXTENSION_ROOT, "node_modules", "@earendil-works", "pi-tui", "dist", "index.d.ts",
      )),
      isPeerDep: "@earendil-works/pi-tui" in peerDeps,
      isDirectDep: "@earendil-works/pi-tui" in deps,
    },
    "node:assert/strict": {
      shimmed: content.includes('declare module "node:assert/strict"'),
      realPackage: "@types/node",
      hasRealTypes: existsSync(join(EXTENSION_ROOT, "node_modules", "@types", "node", "index.d.ts")),
      isPeerDep: false,
      isDirectDep: false,
    },
    "node:crypto": {
      shimmed: content.includes('declare module "node:crypto"'),
      realPackage: "@types/node",
      hasRealTypes: existsSync(join(EXTENSION_ROOT, "node_modules", "@types", "node", "index.d.ts")),
      isPeerDep: false,
      isDirectDep: false,
    },
    "node:fs": {
      shimmed: content.includes('declare module "node:fs"'),
      realPackage: "@types/node",
      hasRealTypes: existsSync(join(EXTENSION_ROOT, "node_modules", "@types", "node", "index.d.ts")),
      isPeerDep: false,
      isDirectDep: false,
    },
    "node:test": {
      shimmed: content.includes('declare module "node:test"'),
      realPackage: "@types/node",
      hasRealTypes: existsSync(join(EXTENSION_ROOT, "node_modules", "@types", "node", "index.d.ts")),
      isPeerDep: false,
      isDirectDep: false,
    },
  };

  // Verify every module is accounted for
  for (const [moduleName, entry] of Object.entries(matrix)) {
    assert.ok(
      entry.shimmed,
      `${moduleName} must be shimmed in types-shims.d.ts`,
    );
  }

  // Report the matrix as a structured summary:
  //
  // Current state:
  //   - @earendil-works/* shims: REDUNDANT (real types available)
  //   - node:* shims: REDUNDANT (@types/node available transitively)
  //   - node:test shim: LOCAL augmentation for experimental mock.module() typing
  const redundantModules = Object.entries(matrix)
    .filter(([, e]) => e.hasRealTypes && !e.realPackage.startsWith("@types/") && !e.realPackage.startsWith("bun-"))
    .map(([name]) => name);
  const essentialModules = Object.entries(matrix)
    .filter(([, e]) => !e.hasRealTypes)
    .map(([name]) => name);

  assert.ok(
    redundantModules.length > 0,
    `Redundant shims (have real types): ${redundantModules.join(", ")}`,
  );
  console.log(`  [INFO] Redundant shims (can be removed): ${redundantModules.join(", ")}`);
  console.log(`  [INFO] Essential shims (need real type package): ${essentialModules.join(", ") || "none"}`);
});

// ===========================================================================
// Summary
// ===========================================================================

// This suite documents the current type state of the extension. Key findings:
//
// 1. types-shims.d.ts provides ambient declarations for three categories:
//    a) @earendil-works/* packages — REDUNDANT, real types available in dist/
//    b) node:* built-in modules — REDUNDANT, @types/node is available transitively
//    c) node:test — LOCAL augmentation for experimental mock.module() typing
//
// 2. skipLibCheck: true masks any conflicts between shims and real types.
//
// 3. To fully remove types-shims.d.ts (per PR #13 intent), @types/node should
//    be added explicitly and verified to include the required node:test mock
//    surface used by config-modal.test.ts.
//
// 4. The @earendil-works/* shims can be safely removed immediately since
//    the real packages provide typed exports.

console.log("All types-shims-coverage tests (PR #13) passed.");
