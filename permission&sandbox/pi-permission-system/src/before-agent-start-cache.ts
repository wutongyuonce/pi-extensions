import { normalizeAgentName, normalizeLineEndings } from "./common.js";

export interface BeforeAgentStartPromptStateInput {
  agentName: string | null;
  cwd: string;
  permissionStamp: string;
  systemPrompt: string;
  allowedToolNames: readonly string[];
}

function createCacheKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

export function createActiveToolsCacheKey(allowedToolNames: readonly string[]): string {
  return createCacheKey(allowedToolNames);
}

export function createBeforeAgentStartPromptStateKey(input: BeforeAgentStartPromptStateInput): string {
  return createCacheKey([
    normalizeAgentName(input.agentName) ?? "",
    input.cwd,
    input.permissionStamp,
    createActiveToolsCacheKey(input.allowedToolNames),
    normalizeLineEndings(input.systemPrompt),
  ]);
}

export function shouldApplyCachedAgentStartState(previousKey: string | null, nextKey: string): boolean {
  return previousKey !== nextKey;
}
