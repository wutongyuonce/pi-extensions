import { readFileSync } from "node:fs";

const reviewHtmlUrl = new URL("../web/dist/index.html", import.meta.url);

export function loadReviewHtml(): string {
  return readFileSync(reviewHtmlUrl, "utf8");
}
