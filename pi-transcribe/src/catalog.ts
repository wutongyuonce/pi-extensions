import { CATALOG_MODELS_GENERATED } from "./catalog.generated.js";

export type CatalogModel = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly repository: string;
  readonly revision: string;
  readonly license: string;
  readonly family: string;
  readonly parameters: string | null;
  readonly languages: readonly string[];
  readonly capabilities: {
    readonly streaming: boolean;
    readonly translate: boolean;
    readonly languageDetection: boolean;
  };
  readonly speedScore: number | null;
  readonly accuracyScore: number | null;
  readonly recommended: boolean;
  readonly recommendedRank: number | null;
  readonly quant: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
};

export const CATALOG_MODELS: readonly CatalogModel[] = CATALOG_MODELS_GENERATED;

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

export function canonicalLanguage(language: string): string {
  return language.trim().toLowerCase().split("-", 1)[0] ?? language.trim().toLowerCase();
}

export function displayLanguage(language: string): string {
  try {
    return languageNames.of(language) ?? language;
  } catch {
    return language;
  }
}

export function getCatalogLanguages(): string[] {
  const languages = new Set<string>();
  for (const model of CATALOG_MODELS) {
    for (const language of model.languages) languages.add(canonicalLanguage(language));
  }
  return [...languages].sort((left, right) => {
    if (left === "en") return -1;
    if (right === "en") return 1;
    return displayLanguage(left).localeCompare(displayLanguage(right));
  });
}

export function modelSupportsLanguage(model: CatalogModel, language: string): boolean {
  return model.languages.includes(language);
}

export function modelMatchesLanguage(model: CatalogModel, language: string): boolean {
  const wanted = canonicalLanguage(language);
  return model.languages.some((supported) => canonicalLanguage(supported) === wanted);
}

export function preferredLanguageMatchCount(
  model: CatalogModel,
  preferredLanguages: readonly string[],
): number {
  return [...new Set(preferredLanguages.map(canonicalLanguage))].filter((language) =>
    modelMatchesLanguage(model, language),
  ).length;
}

function compareCatalogModels(
  left: CatalogModel,
  right: CatalogModel,
): number {
  const leftRank = left.recommendedRank ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.recommendedRank ?? Number.MAX_SAFE_INTEGER;
  return (
    leftRank - rightRank ||
    Number(right.recommended) - Number(left.recommended) ||
    (right.accuracyScore ?? 0) - (left.accuracyScore ?? 0) ||
    (right.speedScore ?? 0) - (left.speedScore ?? 0) ||
    left.name.localeCompare(right.name)
  );
}

export function rankCatalogModels(
  models: readonly CatalogModel[],
  preferredLanguages: readonly string[] = [],
  isDownloaded: (model: CatalogModel) => boolean = () => false,
): CatalogModel[] {
  return [...models].sort(
    (left, right) =>
      preferredLanguageMatchCount(right, preferredLanguages) -
        preferredLanguageMatchCount(left, preferredLanguages) ||
      Number(isDownloaded(right)) - Number(isDownloaded(left)) ||
      compareCatalogModels(left, right),
  );
}

export function catalogModelSearchText(model: CatalogModel): string {
  const capabilities = [
    model.capabilities.streaming ? "streaming live" : "",
    model.capabilities.translate ? "translation translate" : "",
    model.capabilities.languageDetection ? "automatic language detection" : "",
  ];
  const languages = model.languages.flatMap((language) => [language, displayLanguage(language)]);
  return [
    model.id,
    model.name,
    model.description,
    model.family,
    model.parameters ?? "",
    model.repository,
    ...capabilities,
    ...languages,
  ].join(" ");
}

export function getCatalogModel(id: string): CatalogModel | undefined {
  return CATALOG_MODELS.find((model) => model.id === id);
}

export function formatBinarySize(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GiB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
