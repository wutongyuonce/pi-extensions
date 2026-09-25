import { normalizeLineEndings } from "./common.js";

export interface SanitizeSystemPromptResult {
  prompt: string;
  removed: boolean;
}

type LineSection = {
  start: number;
  end: number;
};

type GuidelineRule = {
  matches: (guideline: string) => boolean;
  shouldKeep: (allowedTools: ReadonlySet<string>) => boolean;
};

const AVAILABLE_TOOLS_SECTION_HEADER = "Available tools:";
const GUIDELINES_SECTION_HEADER = "Guidelines:";

const TOOL_GUIDELINE_RULES: readonly GuidelineRule[] = [
  {
    matches: (guideline) => guideline === "use bash for file operations like ls, rg, find",
    shouldKeep: (allowedTools) => allowedTools.has("bash"),
  },
  {
    matches: (guideline) => guideline === "prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    shouldKeep: (allowedTools) =>
      allowedTools.has("bash") && (allowedTools.has("grep") || allowedTools.has("find") || allowedTools.has("ls")),
  },
  {
    matches: (guideline) =>
      guideline === "use read to examine files before editing. you must use this tool instead of cat or sed."
        || guideline === "use read to examine files instead of cat or sed.",
    shouldKeep: (allowedTools) => allowedTools.has("read"),
  },
  {
    matches: (guideline) => guideline === "use edit for precise changes (old text must match exactly)",
    shouldKeep: (allowedTools) => allowedTools.has("edit"),
  },
  {
    matches: (guideline) => guideline === "use write only for new files or complete rewrites",
    shouldKeep: (allowedTools) => allowedTools.has("write"),
  },
  {
    matches: (guideline) =>
      guideline === "when summarizing your actions, output plain text directly - do not use cat or bash to display what you did",
    shouldKeep: (allowedTools) => allowedTools.has("edit") || allowedTools.has("write"),
  },
  {
    matches: (guideline) =>
      guideline === "use task when work should be delegated to one or more specialized agents instead of handled entirely in the current session.",
    shouldKeep: (allowedTools) => allowedTools.has("task"),
  },
  {
    matches: (guideline) =>
      guideline === "use mcp for mcp discovery first: search by capability, describe one exact tool name, then call it.",
    shouldKeep: (allowedTools) => allowedTools.has("mcp"),
  },
];

function collapseExtraBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function normalizeGuidelineText(line: string): string {
  return line.trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ").toLowerCase();
}

function isTopLevelSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.endsWith(":") && !trimmed.startsWith("-");
}

function findSection(lines: readonly string[], header: string): LineSection | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelSectionHeader(lines[index])) {
      end = index;
      break;
    }
  }

  return { start, end };
}

function removeLineSection(lines: readonly string[], section: LineSection | null): { lines: string[]; removed: boolean } {
  if (!section) {
    return { lines: [...lines], removed: false };
  }

  return {
    lines: [...lines.slice(0, section.start), ...lines.slice(section.end)],
    removed: true,
  };
}

function shouldKeepGuideline(line: string, allowedTools: ReadonlySet<string>): boolean {
  const normalized = normalizeGuidelineText(line);

  for (const rule of TOOL_GUIDELINE_RULES) {
    if (rule.matches(normalized)) {
      return rule.shouldKeep(allowedTools);
    }
  }

  return true;
}

function sanitizeGuidelinesSection(lines: readonly string[], allowedTools: ReadonlySet<string>): { lines: string[]; removed: boolean } {
  const section = findSection(lines, GUIDELINES_SECTION_HEADER);
  if (!section) {
    return { lines: [...lines], removed: false };
  }

  const before = lines.slice(0, section.start + 1);
  const after = lines.slice(section.end);
  const body = lines.slice(section.start + 1, section.end);
  const filteredBody = body.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      return true;
    }

    return shouldKeepGuideline(line, allowedTools);
  });

  const removed = filteredBody.length !== body.length;
  if (!removed) {
    return { lines: [...lines], removed: false };
  }

  const hasBullet = filteredBody.some((line) => line.trim().startsWith("- "));
  if (!hasBullet) {
    return {
      lines: [...lines.slice(0, section.start), ...after],
      removed: true,
    };
  }

  return {
    lines: [...before, ...filteredBody, ...after],
    removed: true,
  };
}

export function sanitizeAvailableToolsSection(
  systemPrompt: string,
  allowedToolNames: readonly string[],
): SanitizeSystemPromptResult {
  const allowedTools = new Set(allowedToolNames.map((toolName) => toolName.trim()).filter(Boolean));
  const normalizedLines = normalizeLineEndings(systemPrompt).split("\n");
  const removedToolsSection = removeLineSection(normalizedLines, findSection(normalizedLines, AVAILABLE_TOOLS_SECTION_HEADER));
  const sanitizedGuidelines = sanitizeGuidelinesSection(removedToolsSection.lines, allowedTools);
  const removed = removedToolsSection.removed || sanitizedGuidelines.removed;

  return {
    prompt: removed ? collapseExtraBlankLines(sanitizedGuidelines.lines.join("\n")) : systemPrompt,
    removed,
  };
}
