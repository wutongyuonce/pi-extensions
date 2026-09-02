import type { ReviewComment } from "./types.js";

function location(comment: ReviewComment): string {
  if (comment.side === "file" || comment.line == null) return comment.path;
  const suffix = comment.side === "original"
    ? comment.mode === "head" ? " (HEAD)" : " (reviewed)"
    : " (current)";
  return `${comment.path}:${comment.line}${suffix}`;
}

export function composeFeedback(comments: ReviewComment[]): string {
  const valid = comments.filter((comment) => comment.body.trim().length > 0);
  if (valid.length === 0) return "";

  const lines = ["Please address the following review feedback:", ""];
  valid.forEach((comment, index) => {
    lines.push(`${index + 1}. ${location(comment)}`);
    lines.push(`   ${comment.body.trim().replace(/\n/g, "\n   ")}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}
