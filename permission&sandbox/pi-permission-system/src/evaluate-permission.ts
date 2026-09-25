import type { PermissionState } from "./types.js";
import { compileWildcardPattern } from "./wildcard-matcher.js";

export type PatternPermissionRule = {
  tool: string;
  pattern: string;
  action: PermissionState;
};

export type PatternPermissionEvaluation = {
  action: PermissionState;
  matchedPattern?: string;
  matchedTool?: string;
};

function isPatternPermissionRule(value: unknown): value is PatternPermissionRule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<PatternPermissionRule>;
  return typeof candidate.tool === "string"
    && typeof candidate.pattern === "string"
    && (candidate.action === "allow" || candidate.action === "deny" || candidate.action === "ask");
}

function normalizeRuleset(value: unknown): PatternPermissionRule[] {
  return Array.isArray(value) ? value.filter(isPatternPermissionRule) : [];
}

export function evaluatePermission(
  tool: string,
  command: string,
  ...rulesets: unknown[]
): PatternPermissionEvaluation {
  const rules = rulesets.flatMap(normalizeRuleset);

  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    const toolPattern = compileWildcardPattern(rule.tool, rule.action);
    if (!toolPattern.regex.test(tool)) {
      continue;
    }

    const commandPattern = compileWildcardPattern(rule.pattern, rule.action);
    if (!commandPattern.regex.test(command)) {
      continue;
    }

    return {
      action: rule.action,
      matchedPattern: rule.pattern,
      matchedTool: rule.tool,
    };
  }

  return { action: "ask" };
}
