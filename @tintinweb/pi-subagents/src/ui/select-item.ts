/**
 * select-item.ts — pick an item from a list via `ctx.ui.select`, safely.
 *
 * Pi's dialog API is `select(title, options: string[]) => Promise<string | undefined>`:
 * strings in, string out, with no index or value form. Callers therefore have to
 * map the returned string back to the item it came from, and the obvious way —
 * `labels.indexOf(choice)` over a parallel array — silently resolves to the
 * FIRST match whenever two rows format identically. Row formatters here truncate
 * (job names to 18 chars, agent descriptions to whatever fits), and the text they
 * truncate is LLM-authored, so collisions are ordinary rather than exotic.
 *
 * This numbers every row, which makes the labels unique by construction — no
 * data-dependent branch that only executes in the case nobody exercises — and
 * keeps each label paired with its item so a later edit that sorts or filters
 * between building and resolving cannot desync them.
 */

/** Minimal shape of the `ctx.ui` surface this needs. */
export interface SelectUI {
  select(title: string, options: string[]): Promise<string | undefined>;
}

/**
 * Show a numbered picker and return the chosen item (not its label).
 *
 * Returns undefined when the user escapes, or when the returned string is not
 * one we offered.
 */
export async function selectItem<T>(
  ui: SelectUI,
  title: string,
  items: readonly T[],
  format: (item: T, index: number) => string,
): Promise<T | undefined> {
  // Pad the number so a 10+ item list keeps its columns aligned.
  const width = String(items.length).length;
  const rows = items.map((item, i) => ({
    item,
    label: `${String(i + 1).padStart(width)}. ${format(item, i)}`,
  }));

  const choice = await ui.select(title, rows.map(r => r.label));
  if (!choice) return undefined;
  return rows.find(r => r.label === choice)?.item;
}
