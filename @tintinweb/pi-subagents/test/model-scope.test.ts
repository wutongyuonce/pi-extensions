// src/model-scope.ts had no test file. Its `error` verdict was reachable only
// indirectly, through one nested-tools case; the `warn` verdict — the whole
// reason the policy is a three-way split rather than a boolean — was never
// exercised at all.
//
// The split is the point: a model the ORCHESTRATOR picked at runtime is refused,
// because it can pick again; a model the USER pinned in frontmatter (or that was
// inherited from the parent) only warns, because refusing it would break every
// pinned agent the moment someone enables the setting. Collapsing the two in
// either direction is a one-line edit with no test in the way.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRegistryRef } from "../src/enabled-models.js";
import { checkModelScope, isScopeModelsEnabled, setScopeModelsEnabled } from "../src/model-scope.js";

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

function makeRegistry(models = MODELS): ModelRegistryRef {
  return { getAll() { return models; }, getAvailable: undefined };
}

const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const OPUS = { provider: "anthropic", id: "claude-opus-4-6" };

describe("checkModelScope", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevEnabled: boolean;

  beforeEach(() => {
    // resolveEnabledModels memoizes on (patterns, mtime+size of both settings
    // files). A fresh project dir per test keeps one case's allowlist from
    // being served to the next.
    projectDir = mkdtempSync(join(tmpdir(), "pi-scope-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-scope-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevEnabled = isScopeModelsEnabled();
  });

  afterEach(() => {
    setScopeModelsEnabled(prevEnabled); // module-global — restore for other suites
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function setEnabledModels(models: string[]) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: models }));
  }

  function check(overrides: Partial<Parameters<typeof checkModelScope>[0]> = {}) {
    return checkModelScope({
      model: OPUS,
      cwd: projectDir,
      modelRegistry: makeRegistry(),
      callerSupplied: true,
      agentLabel: "scout",
      ...overrides,
    });
  }

  it("is a no-op while the feature is off, even for an out-of-scope model", () => {
    setScopeModelsEnabled(false);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(check().kind).toBe("ok");
  });

  it("is a no-op when no model was resolved", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(check({ model: undefined }).kind).toBe("ok");
  });

  it("is a no-op when the user has no enabledModels configured", () => {
    setScopeModelsEnabled(true);
    expect(check().kind).toBe("ok");
  });

  it("is a no-op when enabledModels resolves to nothing usable", () => {
    // Globs and bare ids are deliberately unsupported; an unresolvable list
    // must disable the check rather than lock the user out of every model.
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/*", "haiku"]);
    expect(check().kind).toBe("ok");
  });

  it("passes an in-scope model", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/claude-opus-4-6"]);
    expect(check().kind).toBe("ok");
  });

  describe("out of scope", () => {
    beforeEach(() => {
      setScopeModelsEnabled(true);
      setEnabledModels(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"]);
    });

    it("refuses a caller-supplied choice and lists what is allowed", () => {
      const verdict = check({ callerSupplied: true, modelInput: "anthropic/claude-opus-4-6" });
      expect(verdict.kind).toBe("error");
      const message = (verdict as { message: string }).message;
      expect(message).toContain('"anthropic/claude-opus-4-6"');
      expect(message).toContain("  anthropic/claude-haiku-4-5");
      expect(message).toContain("  anthropic/claude-sonnet-4-6");
    });

    it("only warns for a frontmatter-pinned choice, so the spawn still proceeds", () => {
      const verdict = check({ callerSupplied: false, modelInput: "anthropic/claude-opus-4-6" });
      expect(verdict.kind).toBe("warn");
      expect((verdict as { message: string }).message)
        .toBe('Agent "scout" using out-of-scope model "anthropic/claude-opus-4-6"');
    });

    it("names the resolved model in the warning when there was no raw input", () => {
      // Parent-inherited: nothing was typed, so the label falls back to the
      // resolved provider/id rather than rendering "undefined".
      const verdict = check({ callerSupplied: false, modelInput: undefined });
      expect(verdict.kind).toBe("warn");
      expect((verdict as { message: string }).message).toContain("anthropic/claude-opus-4-6");
      expect((verdict as { message: string }).message).not.toContain("undefined");
    });

    it("stops enforcing as soon as the setting is turned back off", () => {
      expect(check().kind).toBe("error");
      setScopeModelsEnabled(false);
      expect(check().kind).toBe("ok");
    });

    it("treats scope as case-insensitive on both sides", () => {
      setEnabledModels(["Anthropic/Claude-Opus-4-6"]);
      expect(check({ model: OPUS }).kind).toBe("ok");
      expect(check({ model: HAIKU }).kind).toBe("error");
    });
  });
});
