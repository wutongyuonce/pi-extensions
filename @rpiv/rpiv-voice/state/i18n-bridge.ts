/**
 * i18n bridge for rpiv-voice — single thin import surface so every translation
 * call site routes through one place. Backed by `@juicesharp/rpiv-i18n`'s SDK
 * when available; degrades to canonical-English fallbacks when not.
 *
 * - `t(key, fallback)` is `scope("@juicesharp/rpiv-voice")` if the SDK is
 *   installed (live `/languages` updates propagate). If the SDK is missing
 *   (standalone install without rpiv-i18n), `t` is an identity passthrough
 *   that returns the inline English fallback at every call site, so the
 *   extension stays online with English UI.
 * - `getActiveLocale()` exposes the current locale string ("en", "ru", …) so
 *   the STT engine can pre-set Whisper's `language` field for accuracy gains.
 *   Returns `undefined` if rpiv-i18n isn't installed or no locale is active —
 *   in which case Whisper falls back to its built-in auto-detect.
 *
 * Strings are registered ONCE at extension load (see ../index.ts). Call sites
 * MUST use this module at render time — never bake the result into a top-level
 * `const X = t(...)`.
 */

export const I18N_NAMESPACE = "@juicesharp/rpiv-voice";

type ScopeFn = (key: string, fallback: string) => string;
type LocaleFn = () => string | undefined;
type I18nSDK = {
	scope: (namespace: string) => ScopeFn;
	getActiveLocale: LocaleFn;
};

// Prefer the live SDK if installed: closures it returns track the active
// locale, so /languages picker propagates to our render call sites. If the
// SDK isn't installed (standalone install of this extension without
// rpiv-i18n), the dynamic import fails, every t(key, fallback) returns the
// canonical English literal, getActiveLocale returns undefined, and the
// extension stays online with English UI + Whisper auto-detect.
//
// Top-level await is required so a synchronous call sees the resolved scope;
// ESM module loading awaits this before evaluating any importer.
let scopeImpl: ScopeFn;
let activeLocaleImpl: LocaleFn;
try {
	const sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;
	scopeImpl = sdk.scope(I18N_NAMESPACE);
	activeLocaleImpl = sdk.getActiveLocale;
} catch {
	scopeImpl = (_key, fallback) => fallback;
	activeLocaleImpl = () => undefined;
}

export const t: ScopeFn = scopeImpl;
export const getActiveLocale: LocaleFn = activeLocaleImpl;
