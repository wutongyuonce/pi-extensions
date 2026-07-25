import type { FrameworkDetectionResult, StatsData } from "../models.js";

interface OverviewMeta {
  stats: StatsData;
  frameworks: FrameworkDetectionResult;
  suggestedReads: string[];
}

export function renderOverview(meta: OverviewMeta): string {
  const lines = ["# Repo overview"];

  if (meta.frameworks.frameworks.length > 0) {
    lines.push(`- detected: ${meta.frameworks.frameworks.join(", ")}`);
  }
  if (meta.frameworks.entrypoints.length > 0) {
    lines.push(`- likely entrypoints: ${meta.frameworks.entrypoints.slice(0, 8).join(", ")}`);
  }

  lines.push(
    `- files: ${meta.stats.scannedFiles} scanned / ${meta.stats.sourceCandidates} candidates; symbols: ${meta.stats.symbols}`,
  );

  const languages = Object.entries(meta.stats.languages);
  if (languages.length > 0) {
    lines.push(`- languages: ${languages.map(([name, count]) => `${name} ${count}`).join(", ")}`);
  }

  if (meta.suggestedReads.length > 0) {
    lines.push("\n## Suggested next reads");
    meta.suggestedReads.forEach((filePath, index) => {
      lines.push(`${index + 1}. ${filePath}`);
    });
  }

  const scripts = Object.entries(meta.frameworks.packageScripts);
  if (scripts.length > 0) {
    lines.push("\n## Package scripts");
    scripts.slice(0, 12).forEach(([name, command]) => {
      lines.push(`- ${name}: ${command}`);
    });
  }

  return lines.join("\n");
}
