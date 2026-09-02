// Rich-text helpers: mode selection, byte-safe chunking with semantic
// boundaries, and card/post payload builders. Pure functions.

export type ReplyMode = "text" | "post" | "interactive";

const MAX_CARD_BYTES = 30_000;
const MAX_TEXT_BYTES = 120 * 1024;

/** Heuristic: markdown-ish content → interactive card; tables/lists → post. */
export function chooseMessageMode(text: string): ReplyMode {
  const t = text.trim();
  if (!t) return "text";
  const hasMarkdown = /(^|\n)\s*(#|##|###|-|\d+\.|```|>|\*\*|\|)/.test(t) || t.includes("\n\n");
  if (hasMarkdown) {
    if (/(^|\n)\s*(\|.*\|(\n|$)|-.*-.*-.*\|)/.test(t)) return "post";
    if (/(^|\n)\s*```/.test(t)) return "interactive";
    return "interactive";
  }
  return "text";
}

/** Split text into UTF-8-safe chunks bounded by maxBytes, cutting on newlines. */
export function splitText(text: string, maxBytes = MAX_TEXT_BYTES): string[] {
  const out: string[] = [];
  let rest = text.trim() || "(empty response)";
  while (Buffer.byteLength(rest, "utf8") > maxBytes) {
    const cut = findCutIndex(rest, maxBytes);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

function findCutIndex(text: string, maxBytes: number): number {
  let lo = 1;
  let hi = text.length;
  let best = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const safe = avoidHalfSurrogate(text, mid);
    if (safe > 0 && Buffer.byteLength(text.slice(0, safe), "utf8") <= maxBytes) {
      best = safe;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const newline = text.lastIndexOf("\n", best);
  if (newline > 0 && newline >= Math.floor(best * 0.6)) return newline + 1;
  return Math.max(1, best);
}

function avoidHalfSurrogate(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  return index;
}

/** Build a Feishu interactive card JSON (schema 2.0-ish, markdown body). */
export function buildMarkdownCard(text: string, extraElements: unknown[] = []): unknown {
  const paragraphs = splitText(text, MAX_CARD_BYTES);
  const elements: unknown[] = [];
  for (const p of paragraphs) {
    elements.push({
      tag: "markdown",
      content: p,
    });
  }
  elements.push(...extraElements);
  return {
    schema: "2.0",
    body: { elements },
  };
}

/** Build a Feishu post (rich text) payload from markdown-ish text. */
export function buildPostPayload(text: string): unknown {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const content = lines.slice(0, 50).map((line) => [
    { tag: "text", text: line.replace(/^[-*]\s+/, "• ").replace(/^#+\s*/, "") },
  ]);
  return { content };
}

/** Count how many chunks a message would split into. */
export function chunkCount(text: string, maxBytes = MAX_CARD_BYTES): number {
  return splitText(text, maxBytes).length;
}
