import { afterEach, describe, expect, it } from "vitest";
import { extractOAuthConfig } from "../mcp-auth-flow.ts";
import {
  interpolateEnvRecord,
  interpolateEnvVars,
  resolveConfigPath,
  resolveServerUrl,
} from "../utils.ts";

describe("OpenCode environment interpolation", () => {
  const original = {
    MCP_TEST_VALUE: process.env.MCP_TEST_VALUE,
    MCP_TEST_URL: process.env.MCP_TEST_URL,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("supports {env:VAR} in env, headers, cwd, and OAuth fields", () => {
    process.env.MCP_TEST_VALUE = "interpolated";
    process.env.MCP_TEST_URL = "https://example.test/mcp";

    expect(interpolateEnvVars("prefix-{env:MCP_TEST_VALUE}")).toBe("prefix-interpolated");
    expect(interpolateEnvRecord({ Authorization: "Bearer {env:MCP_TEST_VALUE}" })).toEqual({
      Authorization: "Bearer interpolated",
    });
    expect(resolveConfigPath("{env:MCP_TEST_VALUE}/server")).toBe("interpolated/server");
    expect(extractOAuthConfig({
      url: "https://example.test/mcp",
      oauth: {
        clientId: "{env:MCP_TEST_VALUE}-client",
        clientSecret: "{env:MCP_TEST_VALUE}-secret",
        scope: "scope-{env:MCP_TEST_VALUE}",
      },
    })).toEqual({
      clientId: "interpolated-client",
      clientSecret: "interpolated-secret",
      scope: "scope-interpolated",
    });
  });

  it("rejects non-string OAuth fields before interpolation", () => {
    expect(() => extractOAuthConfig({
      url: "https://example.test/mcp",
      oauth: { clientId: 42 } as any,
    })).toThrow("OAuth clientId must be a string");
  });

  it("fails closed before URL resolution when a brace variable is missing", () => {
    delete process.env.MCP_TEST_URL;
    expect(() => resolveServerUrl({ url: "https://{env:MCP_TEST_URL}/mcp" })).toThrow(
      "Missing environment variable in MCP server URL: MCP_TEST_URL",
    );
  });
});
