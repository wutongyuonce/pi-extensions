import type { Symbol } from "../models.js";

export function renderMap(allSymbols: Record<string, Symbol[]>, tokenBudget: number): string {
  if (Object.keys(allSymbols).length === 0) {
    return "# No symbols found";
  }

  const charBudget = tokenBudget * 4;
  let current = 0;
  const lines: string[] = [];

  const fileScores = Object.entries(allSymbols)
    .filter(([, symbols]) => symbols.length > 0)
    .map(([filePath, symbols]) => ({
      filePath,
      total: symbols.reduce((sum, symbol) => sum + symbol.importance, 0),
      symbols,
    }))
    .sort((left, right) => right.total - left.total || left.filePath.localeCompare(right.filePath));

  for (const fileScore of fileScores) {
    const header = `- ${fileScore.filePath}:`;
    if (current + header.length > charBudget) {
      break;
    }

    lines.push(header);
    current += header.length + 1;

    for (const symbol of [...fileScore.symbols].sort((left, right) => right.importance - left.importance || left.line - right.line).slice(0, 30)) {
      let entry = `  ${symbol.kind} ${symbol.name} (line ${symbol.line})`;
      if (symbol.refCount > 0) {
        entry += `  ← ${symbol.refCount} files`;
      }
      if (current + entry.length > charBudget) {
        break;
      }
      lines.push(entry);
      current += entry.length + 1;
    }
  }

  return lines.join("\n");
}

export function renderSuggestions(reads: string[]): string {
  if (reads.length === 0) {
    return "";
  }
  return ["", "## Suggested next reads", ...reads.map((path, index) => `${index + 1}. ${path}`)].join("\n");
}
