/** Shared lazy formatter catalog seam (#1394). */
import { createLazyImport } from "./lazy-import.js";

type FormatterModule = typeof import("./formatters.js");
const lazyFormatters = createLazyImport<FormatterModule>(
	() => import("./formatters.js"),
);

export function warmFormatters(): Promise<FormatterModule> {
	return lazyFormatters.get();
}

export function loadFormatters(): Promise<FormatterModule> {
	return warmFormatters();
}
