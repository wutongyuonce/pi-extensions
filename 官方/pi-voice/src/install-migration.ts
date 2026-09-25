import type { SlashCommandInfo, SourceInfo } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const NOTICE_MARKER_FILENAME = ".pi-voice-legacy-git-notice-v1";
const LEGACY_GIT_REPOSITORY =
  /github\.com(?::|\/)earendil-works\/pi-transcribe(?:\.git)?(?:@.*)?\/?$/i;

/** Find a loaded package that still uses the pre-rename Git repository source. */
export function findLegacyGitInstall(
  commands: readonly SlashCommandInfo[],
): SourceInfo | undefined {
  return commands.find(
    (command) =>
      command.source === "extension" &&
      command.sourceInfo.origin === "package" &&
      LEGACY_GIT_REPOSITORY.test(command.sourceInfo.source),
  )?.sourceInfo;
}

/** Atomically claim the one-time notice across concurrently running Pi processes. */
export async function claimLegacyGitNotice(): Promise<boolean> {
  try {
    await writeFile(join(getAgentDir(), NOTICE_MARKER_FILENAME), "shown\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // A read-only config directory should not prevent the user from seeing the
    // migration guidance, even though it means the notice may appear again.
    return true;
  }
}

export function legacyGitMigrationMessage(sourceInfo: SourceInfo): string {
  const local = sourceInfo.scope === "project" ? " -l" : "";
  return [
    "Pi Voice is still installed from the old pi-transcribe Git repository.",
    "For stable npm updates, replace it with the renamed package:",
    `pi remove${local} ${sourceInfo.source}`,
    `pi install${local} npm:@earendil-works/pi-voice`,
  ].join("\n");
}
