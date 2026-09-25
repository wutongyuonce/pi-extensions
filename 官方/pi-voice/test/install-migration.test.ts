import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SlashCommandInfo,
  SourceInfo,
} from "@earendil-works/pi-coding-agent";
import { findLegacyGitInstall } from "../src/install-migration.js";

function command(
  source: string,
  options: Partial<SourceInfo> = {},
): SlashCommandInfo {
  return {
    name: "voice-settings",
    source: "extension",
    sourceInfo: {
      path: "/package/index.ts",
      source,
      scope: "user",
      origin: "package",
      ...options,
    },
  };
}

test("detects supported forms of the old pi-transcribe Git source", () => {
  for (const source of [
    "git:github.com/earendil-works/pi-transcribe",
    "git:git@github.com:earendil-works/pi-transcribe",
    "ssh://git@github.com/earendil-works/pi-transcribe",
    "https://github.com/earendil-works/pi-transcribe.git",
    "git:github.com/earendil-works/pi-transcribe@v0.1.0",
  ]) {
    assert.equal(findLegacyGitInstall([command(source)])?.source, source);
  }
});

test("does not flag npm, the renamed Git repository, or top-level checkouts", () => {
  assert.equal(
    findLegacyGitInstall([
      command("npm:@earendil-works/pi-transcribe"),
      command("git:github.com/earendil-works/pi-voice"),
      command("git:github.com/earendil-works/pi-transcribe", { origin: "top-level" }),
    ]),
    undefined,
  );
});
