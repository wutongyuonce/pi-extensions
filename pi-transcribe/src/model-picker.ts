import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CATALOG_MODELS,
  catalogModelSearchText,
  canonicalLanguage,
  displayLanguage,
  formatBinarySize,
  getCatalogLanguages,
  modelMatchesLanguage,
  rankCatalogModels,
  type CatalogModel,
} from "./catalog.js";
import { findCachedCatalogModel, type CachedCatalogModel } from "./models.js";
import type { TranscriptionLanguage } from "./settings.js";

type UiTheme = ExtensionContext["ui"]["theme"];

const MAX_VISIBLE_LANGUAGES = 9;
const MAX_VISIBLE_MODELS = 10;
// List rows render as margin(1) + cursor gutter ("→ ") + content, so content
// starts at column 3. Headers, search, and footers pad to that same column and
// the cursor arrow hangs in the gutter to their left.
const LIST_PADDING = 1;
const TEXT_PADDING = 3;
// Longest catalog language name is "Norwegian Nynorsk" (17).
const LANGUAGE_NAME_WIDTH = 20;
const MODEL_NAME_WIDTH = 34;
const MODEL_SIZE_WIDTH = 11;
const TRANSCRIPTION_LANGUAGE_NAME_WIDTH = 28;

function padColumn(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function transcriptionLanguageName(
  language: string,
  supportedLanguages: readonly string[],
): string {
  const base = canonicalLanguage(language);
  const variants = supportedLanguages.filter(
    (supported) => canonicalLanguage(supported) === base,
  );
  return displayLanguage(variants.length > 1 ? language : base);
}

function selectedWindow<T>(items: readonly T[], selected: number, maximum: number): [number, number] {
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maximum / 2), items.length - maximum),
  );
  return [start, Math.min(start + maximum, items.length)];
}

export type LanguageSelection = {
  languages: string[];
  /** False when the picker was closed with Esc instead of Continue. */
  confirmed: boolean;
};

class LanguagePicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly selected: Set<string>;
  private ordered: string[] = [];
  private filtered: string[] = [];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    initial: readonly string[],
    private readonly cancelLabel: string,
    private readonly done: (result: LanguageSelection | undefined) => void,
  ) {
    super();
    const available = getCatalogLanguages();
    this.selected = new Set(
      initial.map(canonicalLanguage).filter((language) => available.includes(language)),
    );
    this.reorder();

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("accent", theme.bold("Select the languages you speak")), TEXT_PADDING, 0),
    );
    this.addChild(
      new Text(
        theme.fg("muted", "Used to recommend models"),
        TEXT_PADDING,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    // The search caret sits in the gutter, aligned with the list cursor; its
    // "> " prompt then puts the typed query on the content edge.
    const searchBox = new Box(LIST_PADDING, 0);
    searchBox.addChild(this.search);
    this.addChild(searchBox);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.refresh();
  }

  private selectedLanguages(): string[] {
    return getCatalogLanguages().filter((language) => this.selected.has(language));
  }

  // Selected languages are pinned to the top of the list so the current
  // selection is always visible without scrolling.
  private reorder(): void {
    const available = getCatalogLanguages();
    this.ordered = [
      ...available.filter((language) => this.selected.has(language)),
      ...available.filter((language) => !this.selected.has(language)),
    ];
  }

  private continueRowIndex(): number {
    return this.filtered.length;
  }

  private refresh(focusLanguage?: string): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.ordered, query, (language) => `${displayLanguage(language)} ${language}`)
      : this.ordered;
    if (focusLanguage) {
      const index = this.filtered.indexOf(focusLanguage);
      if (index >= 0) this.selectedIndex = index;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.continueRowIndex());
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching languages"), LIST_PADDING, 0));
    } else {
      // In the unfiltered list, a rule separates the pinned (selected) group
      // from the rest. It is a real row in the scroll window (null entry), so
      // it scrolls like any other line instead of appearing and disappearing,
      // which would shift the layout below the list.
      const boundary =
        !query && this.selected.size > 0 && this.selected.size < this.filtered.length
          ? this.selected.size
          : -1;
      const rows: (string | null)[] =
        boundary >= 0
          ? [...this.filtered.slice(0, boundary), null, ...this.filtered.slice(boundary)]
          : [...this.filtered];
      const cursorRow =
        boundary >= 0 && this.selectedIndex >= boundary
          ? this.selectedIndex + 1
          : this.selectedIndex;
      // +1 so the window holds the same line count with or without the rule.
      const [start, end] = selectedWindow(rows, cursorRow, MAX_VISIBLE_LANGUAGES + 1);
      for (let index = start; index < end; index += 1) {
        const language = rows[index]!;
        if (language === null) {
          this.list.addChild(
            new Text(`  ${this.theme.fg("dim", "─".repeat(LANGUAGE_NAME_WIDTH + 6))}`, LIST_PADDING, 0),
          );
          continue;
        }
        const active = index === cursorRow;
        const checked = this.selected.has(language);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const mark = checked ? this.theme.fg("success", "[×]") : this.theme.fg("dim", "[ ]");
        const name = padColumn(displayLanguage(language), LANGUAGE_NAME_WIDTH);
        this.list.addChild(
          new Text(
            `${prefix}${mark} ${active ? this.theme.fg("accent", name) : name}${this.theme.fg("dim", language)}`,
            LIST_PADDING,
            0,
          ),
        );
      }
    }

    const selected = this.selectedLanguages();
    const onContinue = this.selectedIndex === this.continueRowIndex();
    const continuePrefix = onContinue ? this.theme.fg("accent", "→ ") : "  ";
    const continueRow = selected.length === 0
      ? this.theme.fg("warning", "Select at least one language to continue")
      : this.theme.inverse(
          onContinue
            ? this.theme.fg("accent", this.theme.bold(" tab  Continue "))
            : this.theme.fg("success", " tab  Continue "),
        );
    this.list.addChild(new Spacer(1));
    this.list.addChild(new Text(`${continuePrefix}${continueRow}`, LIST_PADDING, 0));

    this.footer.setText(
      `${rawKeyHint("↑↓", "move")}  ${rawKeyHint("space/enter", "select")}  ${keyHint("tui.select.cancel", query ? "clear search" : this.cancelLabel)}`,
    );
    this.tui.requestRender();
  }

  private toggleHighlighted(): void {
    const language = this.filtered[this.selectedIndex];
    if (!language) return;
    const adding = !this.selected.has(language);
    if (adding) this.selected.add(language);
    else this.selected.delete(language);
    this.reorder();
    // A search query is spent once used: clear it so the full list returns.
    this.search.setValue("");
    // Follow a newly selected language so the user sees it land in the pinned
    // group; on deselect stay put — trailing the language to its new spot far
    // down the list is disorienting.
    this.refresh(adding ? language : undefined);
  }

  handleInput(data: string): void {
    const lastIndex = this.continueRowIndex();
    if (this.keybindings.matches(data, "tui.input.tab")) {
      const selected = this.selectedLanguages();
      if (selected.length > 0) this.done({ languages: selected, confirmed: true });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? lastIndex : this.selectedIndex - 1;
      this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === lastIndex ? 0 : this.selectedIndex + 1;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleHighlighted();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.selectedIndex === this.continueRowIndex()) {
        const selected = this.selectedLanguages();
        if (selected.length > 0) this.done({ languages: selected, confirmed: true });
        return;
      }
      // Enter on a language toggles it, so landing Enter never silently
      // confirms a selection the user was not pointing at.
      this.toggleHighlighted();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        // Esc keeps the current selection; only an empty selection reads as
        // "never mind".
        const selected = this.selectedLanguages();
        this.done(
          selected.length > 0 ? { languages: selected, confirmed: false } : undefined,
        );
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

type CatalogModelPickerResult =
  | { type: "change-languages" }
  | { type: "complete" };

type CatalogModelActivation = (
  model: CatalogModel,
  options: {
    cached: CachedCatalogModel | undefined;
    signal: AbortSignal;
    onProgress: (progress: { downloaded: number; total: number }) => void;
  },
) => Promise<{ path: string }>;

type CatalogModelPickerMode = "models" | "confirm-download" | "downloading";

class CatalogModelPicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly searchBox = new Box(LIST_PADDING, 0);
  private readonly body = new Container();
  private readonly preferredLine = new Text("", TEXT_PADDING, 0);
  private readonly list = new Container();
  private readonly detail = new Text("", TEXT_PADDING, 0);
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly cachedById = new Map<string, CachedCatalogModel>();
  private readonly models: CatalogModel[];
  private readonly languageColumns: readonly string[];
  private filtered: CatalogModel[] = [];
  private selectedIndex = 0;
  /** Last selection whose activation finished; what settings actually hold. */
  private committedModelId: string | undefined;
  private mode: CatalogModelPickerMode = "models";
  /** Model awaiting the download confirmation prompt. */
  private pendingModel: CatalogModel | undefined;
  /** Latest selection still activating; a newer selection supersedes it. */
  private target: { model: CatalogModel; controller: AbortController } | undefined;
  /** Exit requested while a save was in flight; fires when the save lands. */
  private pendingExit: { result: CatalogModelPickerResult | undefined } | undefined;
  private downloadMessage = "";
  private feedback: { type: "success" | "error"; text: string } | undefined;
  private selectedDuringSession = false;
  private disposed = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && this.mode === "models";
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly preferredLanguages: readonly string[],
    currentModelId: string | undefined,
    private readonly done: (result: CatalogModelPickerResult | undefined) => void,
    private readonly onActivate: CatalogModelActivation,
    private readonly continueAfterActivation = false,
    alreadyActivated = false,
  ) {
    super();
    this.committedModelId = currentModelId;
    this.selectedDuringSession = alreadyActivated;
    for (const model of CATALOG_MODELS) {
      const cached = findCachedCatalogModel(model);
      if (cached) this.cachedById.set(model.id, cached);
    }
    this.models = rankCatalogModels(
      CATALOG_MODELS,
      preferredLanguages,
      (model) => this.cachedById.has(model.id),
    );
    this.languageColumns = [...new Set(preferredLanguages.map(canonicalLanguage))];
    const currentIndex = this.models.findIndex((model) => model.id === currentModelId);
    if (currentIndex > 0) {
      const [current] = this.models.splice(currentIndex, 1);
      if (current) this.models.unshift(current);
    }

    this.searchBox.addChild(this.search);
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Choose a transcription model")), TEXT_PADDING, 0));
    this.addChild(this.preferredLine);
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    this.refresh();
  }

  // One column per preferred language, in preference order: green when the
  // model supports it, dim when it does not.
  private languageMatrix(model: CatalogModel): string {
    return this.languageColumns
      .map((language) =>
        modelMatchesLanguage(model, language)
          ? this.theme.fg("success", language)
          : this.theme.fg("dim", language),
      )
      .join(" ");
  }

  // The ● follows the in-flight selection the moment Enter lands; if that
  // activation fails it falls back to the committed model on its own.
  private displayedModelId(): string | undefined {
    return this.target?.model.id ?? this.committedModelId;
  }

  private refresh(): void {
    this.body.clear();
    const preferred = this.theme.fg(
      "muted",
      `Preferred: ${this.preferredLanguages.map(displayLanguage).join(", ")}`,
    );
    const preferredAction = this.selectedDuringSession
      ? this.continueAfterActivation
        ? ` · ${keyHint("tui.input.tab", "continue")}`
        : ""
      : ` · ${keyHint("tui.input.tab", "change")}`;
    this.preferredLine.setText(`${preferred}${preferredAction}`);
    this.search.focused = this._focused && this.mode === "models";

    if (this.mode === "confirm-download") {
      const model = this.pendingModel!;
      this.body.addChild(new Spacer(1));
      this.body.addChild(new Text(this.theme.bold(model.name), TEXT_PADDING, 0));
      this.body.addChild(
        new Text(
          [
            `Download ${formatBinarySize(model.size)} from Hugging Face?`,
            `License: ${model.license}`,
            "Audio never leaves this machine.",
          ].join("\n"),
          TEXT_PADDING,
          0,
        ),
      );
      this.body.addChild(new Spacer(1));
      this.body.addChild(
        new Text(
          `${keyHint("tui.select.confirm", "download")}  ${keyHint("tui.select.cancel", "back")}`,
          TEXT_PADDING,
          0,
        ),
      );
      // An earlier selection can fail while this prompt is open; surface it
      // here instead of holding it for the list view.
      if (this.feedback) {
        this.body.addChild(new Spacer(1));
        this.body.addChild(
          new Text(this.theme.fg(this.feedback.type, this.feedback.text), TEXT_PADDING, 0),
        );
      }
      this.tui.requestRender();
      return;
    }

    if (this.mode === "downloading") {
      const model = this.target!.model;
      this.body.addChild(new Spacer(1));
      this.body.addChild(
        new Text(
          this.theme.fg("accent", this.theme.bold(`Downloading ${model.name}`)),
          TEXT_PADDING,
          0,
        ),
      );
      this.body.addChild(new Text(this.theme.fg("muted", this.downloadMessage), TEXT_PADDING, 0));
      this.body.addChild(new Spacer(1));
      this.body.addChild(
        new Text(keyHint("tui.select.cancel", "cancel"), TEXT_PADDING, 0),
      );
      this.tui.requestRender();
      return;
    }

    this.body.addChild(new Spacer(1));
    this.body.addChild(this.searchBox);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.list);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.detail);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.footer);

    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.models, query, catalogModelSearchText)
      : this.models;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.list.clear();
    const displayedId = this.displayedModelId();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching models"), LIST_PADDING, 0));
      this.detail.setText("");
    } else {
      const [start, end] = selectedWindow(this.filtered, this.selectedIndex, MAX_VISIBLE_MODELS);
      for (let index = start; index < end; index += 1) {
        const model = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const cached = this.cachedById.get(model.id);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const current = model.id === displayedId
          ? this.theme.fg("accent", "●")
          : " ";
        const nameText = model.name.padEnd(MODEL_NAME_WIDTH);
        const name = active ? this.theme.fg("accent", nameText) : nameText;
        const sizeText = formatBinarySize(model.size);
        const downloaded = cached ? ` ${this.theme.fg("success", "✓")}` : "";
        const sizePadding = " ".repeat(
          Math.max(0, MODEL_SIZE_WIDTH - visibleWidth(sizeText) - (cached ? 2 : 0)),
        );
        const detail = `${this.theme.fg("dim", sizeText)}${downloaded}${sizePadding}`;
        const recommended = model.recommended
          ? `  ${this.theme.fg("accent", "recommended")}`
          : "";
        this.list.addChild(
          new Text(
            `${prefix}${current} ${name}  ${this.languageMatrix(model)}  ${detail}${recommended}`,
            LIST_PADDING,
            0,
          ),
        );
      }
      if (start > 0 || end < this.filtered.length) {
        this.list.addChild(
          new Text(
            this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`),
            LIST_PADDING,
            0,
          ),
        );
      }

      const selected = this.filtered[this.selectedIndex]!;
      const languageCount = new Set(selected.languages.map(canonicalLanguage)).size;
      const features = [
        selected.capabilities.languageDetection ? "auto language detection" : undefined,
        `${languageCount} language${languageCount === 1 ? "" : "s"}`,
        selected.parameters ?? undefined,
      ].filter((value): value is string => Boolean(value));
      const feedback = this.feedback
        ? `\n${this.theme.fg(this.feedback.type, this.feedback.text)}`
        : "";
      this.detail.setText(
        `${this.theme.fg("muted", selected.description)}\n${this.theme.fg("dim", features.join(" · "))}${feedback}`,
      );
    }

    const shown = query
      ? `${this.filtered.length}/${this.models.length} matching models`
      : `${this.models.length} models`;
    const statusLegend = [
      displayedId
        ? `${this.theme.fg("accent", "●")} ${this.theme.fg("dim", "current")}`
        : undefined,
      `${this.theme.fg("success", "✓")} ${this.theme.fg("dim", "downloaded")}`,
    ]
      .filter((value): value is string => Boolean(value))
      .join("  ");
    const continueHint = this.selectedDuringSession && this.continueAfterActivation
      ? `  ${keyHint("tui.input.tab", "continue")}`
      : "";
    const closeLabel = query ? "clear search" : this.selectedDuringSession ? "back" : "cancel";
    this.footer.setText(
      `${this.theme.fg("dim", shown)}  ${statusLegend}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "choose")}${continueHint}  ${keyHint("tui.select.cancel", closeLabel)}`,
    );
    this.tui.requestRender();
  }

  // Exit keys wait for an in-flight save (milliseconds): success closes as
  // requested, failure keeps the picker open so the error stays visible.
  private requestExit(result: CatalogModelPickerResult | undefined): void {
    if (this.target) {
      this.pendingExit = { result };
      return;
    }
    this.done(result);
  }

  private startActivation(model: CatalogModel): void {
    const cached = this.cachedById.get(model.id);
    // Re-selecting the active model is a no-op unless an activation is still
    // needed to unlock the "continue" affordance.
    if (
      model.id === this.displayedModelId() &&
      cached &&
      (this.selectedDuringSession || !this.continueAfterActivation)
    ) {
      this.feedback = undefined;
      this.refresh();
      return;
    }

    // The newest selection always wins: an earlier activation still in flight
    // is superseded, never a reason to ignore input. The caller queues commits
    // in selection order, so settings on disk converge to this choice.
    this.target?.controller.abort();
    const controller = new AbortController();
    const activation = { model, controller };
    this.target = activation;
    this.pendingModel = undefined;
    this.feedback = undefined;
    if (!cached) {
      this.mode = "downloading";
      this.downloadMessage = `${formatBinarySize(0)} / ${formatBinarySize(model.size)} · 0%`;
    }
    this.refresh();

    void this.onActivate(model, {
      cached,
      signal: controller.signal,
      onProgress: ({ downloaded, total }) => {
        if (this.disposed || controller.signal.aborted || this.target !== activation) return;
        const percent = total > 0 ? Math.floor((downloaded / total) * 100) : 0;
        this.downloadMessage = `${formatBinarySize(downloaded)} / ${formatBinarySize(total)} · ${percent}%`;
        this.refresh();
      },
    }).then(
      ({ path }) => {
        // Handlers run in commit order, so even a superseded success moves
        // committedModelId to what the settings file held at that moment.
        this.cachedById.set(model.id, { path });
        this.committedModelId = model.id;
        this.selectedDuringSession = true;
        if (this.target === activation) {
          this.target = undefined;
          if (this.mode === "downloading") this.mode = "models";
          const exit = this.pendingExit;
          if (exit) {
            this.pendingExit = undefined;
            this.done(exit.result);
            return;
          }
        }
        if (!this.disposed) this.refresh();
      },
      (error: unknown) => {
        // A failed download or select may have added or removed cache files.
        const cachedAfterFailure = findCachedCatalogModel(model);
        if (cachedAfterFailure) this.cachedById.set(model.id, cachedAfterFailure);
        else this.cachedById.delete(model.id);
        if (this.target === activation) {
          this.target = undefined;
          // A requested exit is cancelled so the failure stays visible.
          this.pendingExit = undefined;
          if (this.mode === "downloading") this.mode = "models";
          this.feedback = controller.signal.aborted
            ? undefined
            : {
                type: "error",
                text: `Could not select ${model.name}: ${error instanceof Error ? error.message : String(error)}`,
              };
        }
        if (!this.disposed) this.refresh();
      },
    );
  }

  handleInput(data: string): void {
    // An exit is waiting on the final save; the picker is already closing.
    if (this.pendingExit) return;
    if (this.mode === "downloading") {
      // Downloading is the one modal state: the progress panel is visible, so
      // ignoring everything except cancel cannot read as a dead keyboard.
      if (this.keybindings.matches(data, "tui.select.cancel") && this.target) {
        this.target.controller.abort();
        this.downloadMessage = `Cancelling ${this.target.model.name}`;
        this.refresh();
      }
      return;
    }

    if (this.mode === "confirm-download") {
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        const model = this.pendingModel;
        if (model) this.startActivation(model);
      } else if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.pendingModel = undefined;
        this.mode = "models";
        this.refresh();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.input.tab")) {
      if (this.selectedDuringSession) {
        if (this.continueAfterActivation) this.requestExit({ type: "complete" });
      } else {
        this.requestExit({ type: "change-languages" });
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (!selected) return;
      if (this.cachedById.has(selected.id)) {
        this.startActivation(selected);
      } else {
        this.pendingModel = selected;
        this.mode = "confirm-download";
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else if (this.selectedDuringSession && this.continueAfterActivation) {
        this.requestExit({ type: "change-languages" });
      } else {
        this.requestExit(undefined);
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    // Closing cancels only a download; a queued settings commit still lands
    // because the user's Enter already chose it.
    if (this.mode === "downloading") this.target?.controller.abort();
  }
}

export function defaultSpokenLanguages(): string[] {
  const locale = canonicalLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  return getCatalogLanguages().includes(locale) ? [locale] : ["en"];
}

export async function chooseLanguages(
  ctx: ExtensionContext,
  initial: readonly string[] = defaultSpokenLanguages(),
  options: { cancelLabel?: string } = {},
): Promise<LanguageSelection | undefined> {
  return ctx.ui.custom<LanguageSelection | undefined>((tui, theme, keybindings, done) =>
    new LanguagePicker(
      tui,
      theme,
      keybindings,
      initial,
      options.cancelLabel ?? "close",
      done,
    ),
  );
}

export async function chooseCatalogModel(
  ctx: ExtensionContext,
  preferredLanguages: readonly string[],
  currentModelId: string | undefined,
  options: {
    onActivate: CatalogModelActivation;
    continueAfterActivation?: boolean;
    /** A model was already activated earlier in this flow, so the picker
     * opens with the post-selection affordances (tab continue, esc back). */
    alreadyActivated?: boolean;
  },
): Promise<CatalogModelPickerResult | undefined> {
  return ctx.ui.custom<CatalogModelPickerResult | undefined>(
    (tui, theme, keybindings, done) =>
      new CatalogModelPicker(
        tui,
        theme,
        keybindings,
        preferredLanguages,
        currentModelId,
        done,
        options.onActivate,
        options.continueAfterActivation,
        options.alreadyActivated,
      ),
  );
}

type TranscriptionLanguageChoice = {
  value: TranscriptionLanguage;
  name: string;
  preferred: boolean;
};

class TranscriptionLanguagePicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly choices: TranscriptionLanguageChoice[];
  private filtered: TranscriptionLanguageChoice[] = [];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    model: CatalogModel,
    current: TranscriptionLanguage,
    preferredLanguages: readonly string[],
    private readonly done: (language: TranscriptionLanguage | undefined) => void,
  ) {
    super();
    const preferred = new Set(preferredLanguages.map(canonicalLanguage));
    const languages = [...new Set(model.languages)]
      .map((language) => ({
        value: language,
        name: transcriptionLanguageName(language, model.languages),
        preferred: preferred.has(canonicalLanguage(language)),
      }))
      .sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) ||
          left.name.localeCompare(right.name) ||
          left.value.localeCompare(right.value),
      );
    this.choices = [
      ...(model.capabilities.languageDetection
        ? [{ value: "auto", name: "Auto detect", preferred: false }]
        : []),
      ...languages,
    ];
    this.filtered = this.choices;
    this.selectedIndex = Math.max(
      0,
      this.choices.findIndex((choice) => choice.value === current),
    );

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("accent", theme.bold("Choose transcription language")), TEXT_PADDING, 0),
    );
    this.addChild(
      new Text(
        theme.fg("muted", "★ Your languages are shown first. Type to search."),
        TEXT_PADDING,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    // The search caret sits in the gutter, aligned with the list cursor; its
    // "> " prompt then puts the typed query on the content edge.
    const searchBox = new Box(LIST_PADDING, 0);
    searchBox.addChild(this.search);
    this.addChild(searchBox);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.refresh();
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.choices, query, (choice) => `${choice.name} ${choice.value}`)
      : this.choices;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1),
    );
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching languages"), LIST_PADDING, 0));
    } else {
      const [start, end] = selectedWindow(
        this.filtered,
        this.selectedIndex,
        MAX_VISIBLE_LANGUAGES,
      );
      for (let index = start; index < end; index += 1) {
        const choice = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const nameText = padColumn(choice.name, TRANSCRIPTION_LANGUAGE_NAME_WIDTH);
        const name = active ? this.theme.fg("accent", nameText) : nameText;
        const code = choice.value === "auto" ? "" : this.theme.fg("dim", choice.value);
        const yours = choice.preferred ? `  ${this.theme.fg("accent", "★")}` : "";
        this.list.addChild(new Text(`${prefix}${name}  ${code}${yours}`, LIST_PADDING, 0));
      }
      if (start > 0 || end < this.filtered.length) {
        this.list.addChild(
          new Text(
            this.theme.fg(
              "muted",
              `  (${this.selectedIndex + 1}/${this.filtered.length})`,
            ),
            LIST_PADDING,
            0,
          ),
        );
      }
    }

    const shown = query
      ? `${this.filtered.length}/${this.choices.length} matching languages`
      : `${this.choices.length} choices`;
    this.footer.setText(
      `${this.theme.fg("dim", shown)}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "choose")}  ${keyHint("tui.select.cancel", query ? "clear search" : "cancel")}`,
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done(selected.value);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        this.done(undefined);
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

export function transcriptionLanguageSummary(
  language: TranscriptionLanguage,
  model: CatalogModel,
): string {
  return language === "auto"
    ? "Auto detect"
    : transcriptionLanguageName(language, model.languages);
}

export async function chooseTranscriptionLanguage(
  ctx: ExtensionContext,
  model: CatalogModel,
  current: TranscriptionLanguage,
  preferredLanguages: readonly string[],
): Promise<TranscriptionLanguage | undefined> {
  return ctx.ui.custom<TranscriptionLanguage | undefined>(
    (tui, theme, keybindings, done) =>
      new TranscriptionLanguagePicker(
        tui,
        theme,
        keybindings,
        model,
        current,
        preferredLanguages,
        done,
      ),
  );
}
