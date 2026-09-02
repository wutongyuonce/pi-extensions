import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  chooseCatalogModel,
  chooseLanguages,
  defaultSpokenLanguages,
} from "./model-picker.js";
import {
  downloadCatalogModel,
  findCachedCatalogModel,
} from "./models.js";
import {
  DEFAULT_MICROPHONE,
  settingsForModel,
  writeSettings,
  type ChineseOutput,
  type MicrophoneSetting,
  type TranscribeSettings,
  type TranscriptionLanguage,
} from "./settings.js";
import { DEFAULT_SHORTCUT } from "./shortcut-core.js";

function requireTui(ctx: ExtensionContext): boolean {
  if (ctx.mode === "tui") return true;
  ctx.ui.notify("pi-transcribe configuration requires the interactive TUI", "error");
  return false;
}

type ModelSelectionOptions = {
  shortcut?: string;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  currentModelId?: string;
  microphone?: MicrophoneSetting;
  onPreferredLanguagesChange?: (languages: string[]) => Promise<void>;
  continueAfterSelection?: boolean;
};

export async function runModelSelection(
  ctx: ExtensionContext,
  options: ModelSelectionOptions = {},
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  let preferredLanguages = [
    ...(options.preferredLanguages ?? defaultSpokenLanguages()),
  ];
  let currentModelId = options.currentModelId;
  let configured: TranscribeSettings | undefined;
  // Back-to-back selections can outrun their settings writes. Commits run in
  // selection order, so the file always ends on the user's last choice.
  let commitQueue: Promise<void> = Promise.resolve();
  const enqueueCommit = (commit: () => Promise<void>): Promise<void> => {
    const result = commitQueue.then(commit);
    commitQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  while (true) {
    const selection = await chooseCatalogModel(
      ctx,
      preferredLanguages,
      currentModelId,
      {
        continueAfterActivation: options.continueAfterSelection,
        // Keep the post-selection affordances when the picker reopens after a
        // round-trip through the language step.
        alreadyActivated: configured !== undefined,
        onActivate: async (model, { cached, signal, onProgress }) => {
          let path: string;
          if (cached) {
            // The picker listed the cache when it opened; re-check so settings
            // never point at a file that has since been evicted. Integrity is
            // covered by the download-time hash and the size check here.
            const stillCached = findCachedCatalogModel(model);
            if (!stillCached) {
              throw new Error(
                "the downloaded file is missing; select the model again to re-download it",
              );
            }
            path = stillCached.path;
          } else {
            path = await downloadCatalogModel(model, { signal, onProgress });
            // Esc during the download tail cancels the selection even though
            // the bytes are already cached.
            signal.throwIfAborted();
          }

          await enqueueCommit(async () => {
            // Skip the write when this selection was superseded or its
            // download was cancelled while the commit sat in the queue.
            signal.throwIfAborted();
            let settings: TranscribeSettings;
            try {
              settings = settingsForModel(model.id, path, {
                shortcut: configured?.shortcut ?? options.shortcut ?? DEFAULT_SHORTCUT,
                preferredLanguages,
                transcriptionLanguage:
                  configured?.transcriptionLanguage ?? options.transcriptionLanguage,
                chineseOutput: configured?.chineseOutput ?? options.chineseOutput,
                microphone: configured?.microphone ?? options.microphone ?? DEFAULT_MICROPHONE,
              });
              await writeSettings(settings);
            } catch (error) {
              throw new Error(
                `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            configured = settings;
            currentModelId = model.id;
          });
          return { path };
        },
      },
    );
    // The picker can close while its last commit is still in flight; wait so
    // configured reflects every selection that will land on disk.
    await commitQueue;

    if (!selection || selection.type === "complete") return configured;

    // Esc and Continue both keep the selection here; the picker edits live
    // state rather than gating it behind a confirm.
    const changed = await chooseLanguages(ctx, preferredLanguages);
    if (changed) {
      try {
        await options.onPreferredLanguagesChange?.(changed.languages);
        preferredLanguages = changed.languages;
        if (configured) {
          configured = { ...configured, preferredLanguages };
          await writeSettings(configured);
        }
      } catch (error) {
        ctx.ui.notify(
          `Could not save preferred languages: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
  }
}

export async function runOnboarding(
  ctx: ExtensionContext,
  shortcut = DEFAULT_SHORTCUT,
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  let languages = defaultSpokenLanguages();
  while (true) {
    const chosen = await chooseLanguages(ctx, languages, { cancelLabel: "skip for now" });
    // Esc exits onboarding: there are no settings yet for a closed picker's
    // selection to be kept in, so only Continue advances.
    if (!chosen?.confirmed) return undefined;
    languages = chosen.languages;
    const configured = await runModelSelection(ctx, {
      shortcut,
      preferredLanguages: languages,
      continueAfterSelection: true,
      onPreferredLanguagesChange: async (changed) => {
        languages = changed;
      },
    });
    if (configured) return configured;
    // Cancelling the model picker returns to the language step; only
    // cancelling the language step exits onboarding.
  }
}
