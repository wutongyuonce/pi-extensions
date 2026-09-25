import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionManager } from "../src/permission-manager.js";
import { runTest } from "./test-harness.js";

runTest("EDGE-RED: PermissionManager rejects path-traversal agent names when loading frontmatter overrides", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-edge-red-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    globalConfigPath,
    `${JSON.stringify({
      defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "allow" },
      tools: { read: "deny" },
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(baseDir, "outside.md"),
    [
      "---",
      "permission:",
      "  tools:",
      "    read: allow",
      "---",
      "# Outside agent file that must not be reachable through '../outside'",
    ].join("\n"),
    "utf8",
  );

  const manager = new PermissionManager({ globalConfigPath, agentsDir });

  try {
    const result = manager.checkPermission("read", {}, "../outside");

    assert.equal(
      result.state,
      "deny",
      "Agent names containing path traversal must not load markdown permission overrides outside the configured agents directory.",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
