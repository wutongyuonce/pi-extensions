import { evaluatePermission, type PatternPermissionRule } from "./evaluate-permission.js";

export class SessionApprovalStore {
  private readonly rules: PatternPermissionRule[] = [];

  approveAlways(tool: string, pattern: string): void {
    const normalizedTool = tool.trim();
    const normalizedPattern = pattern.trim();
    if (!normalizedTool || !normalizedPattern) {
      return;
    }

    this.rules.push({
      tool: normalizedTool,
      pattern: normalizedPattern,
      action: "allow",
    });
  }

  approveOnce(tool: string, pattern: string): void {
    this.approveAlways(tool, pattern);
  }

  hasSessionApproval(tool: string, command: string): boolean {
    return this.evaluate(tool, command).state === "allow";
  }

  evaluate(tool: string, command: string): { state: "allow" | "ask"; matchedPattern?: string } {
    const result = evaluatePermission(tool, command, this.rules);
    return result.action === "allow"
      ? { state: "allow", matchedPattern: result.matchedPattern }
      : { state: "ask" };
  }

  getRules(): PatternPermissionRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  clear(): void {
    this.rules.length = 0;
  }
}
