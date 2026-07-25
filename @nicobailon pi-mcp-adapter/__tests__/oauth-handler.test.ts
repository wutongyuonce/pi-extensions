import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

describe("oauth-handler token compatibility", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("reads tokens from the secure auth store", async () => {
    const { saveAuthEntry } = await import("../mcp-auth.ts");
    const { getStoredTokens } = await import("../oauth-handler.ts");

    saveAuthEntry("demo", {
      tokens: {
        accessToken: "abc",
        refreshToken: "refresh",
        expiresAt: Date.now() / 1000 + 60,
        scope: "read",
      },
    }, "https://example.com/mcp");

    expect(getStoredTokens("demo")).toMatchObject({
      access_token: "abc",
      token_type: "Bearer",
      refresh_token: "refresh",
      scope: "read",
    });
  });

  it("imports legacy tokens from MCP_OAUTH_DIR before returning them", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-agent-"));
    const oauthDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-oauth-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.MCP_OAUTH_DIR = oauthDir;

    const { getAuthEntryFilePath } = await import("../mcp-auth.ts");
    const tokensPath = getAuthEntryFilePath("legacy-demo");
    mkdirSync(dirname(tokensPath), { recursive: true });
    writeFileSync(tokensPath, JSON.stringify({
      tokens: { accessToken: "from-override", refreshToken: "legacy-refresh" },
      serverUrl: "https://example.com/mcp",
    }), "utf-8");

    const { getStoredTokens } = await import("../oauth-handler.ts");
    expect(getStoredTokens("legacy-demo")?.access_token).toBe("from-override");
    expect(getStoredTokens("legacy-demo")?.refresh_token).toBe("legacy-refresh");
  });
});
