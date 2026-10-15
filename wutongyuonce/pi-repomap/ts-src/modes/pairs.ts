export function renderPairs(pairs: Record<string, string[]>, _tokenBudget: number): string {
  if (Object.keys(pairs).length === 0) {
    return "# Test/source pairs\nNo likely pairs found";
  }

  const lines = ["# Test/source pairs"];
  for (const [source, tests] of Object.entries(pairs)) {
    lines.push(`- ${source}`);
    for (const test of tests.slice(0, 8)) {
      lines.push(`  - ${test}`);
    }
  }
  return lines.join("\n");
}
