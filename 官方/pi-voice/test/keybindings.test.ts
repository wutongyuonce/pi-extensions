import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { VoiceKeys } from "../src/keybindings.js";
import { keybindings } from "./ui-helpers.js";

const ESC = String.fromCharCode(0x1b);
const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);
const matchesVoiceKeybinding = (data: string, id: Parameters<VoiceKeys["matches"]>[1]) =>
  new VoiceKeys(keybindings()).matches(data, id);

test("the help shortcut accepts typed and Kitty-protocol question marks only", () => {
  for (const data of ["?", `${ESC}[63u`, `${ESC}[63;2u`, `${ESC}[47:63;2u`]) {
    assert.equal(matchesVoiceKeybinding(data, "voice.models.ratingsHelp"), true, JSON.stringify(data));
  }
  for (const data of ["/", "qwen?", `${ESC}[200~?${ESC}[201~`, `${ESC}[63;5u`]) {
    assert.equal(matchesVoiceKeybinding(data, "voice.models.ratingsHelp"), false, JSON.stringify(data));
  }
});

test("letter shortcuts accept either case and Kitty reports, never control keys", () => {
  for (const data of ["o", "O", `${ESC}[111u`, `${ESC}[111;2u`]) {
    assert.equal(matchesVoiceKeybinding(data, "voice.recommendations.browseAll"), true, JSON.stringify(data));
  }
  for (const data of [ctrl("o"), "oo", `${ESC}[111;5u`]) {
    assert.equal(matchesVoiceKeybinding(data, "voice.recommendations.browseAll"), false, JSON.stringify(data));
  }
  assert.equal(matchesVoiceKeybinding(ctrl("l"), "voice.languages.change"), true);
  assert.equal(matchesVoiceKeybinding("l", "voice.languages.change"), false);
});

test("VoiceKeys routes pi ids to the injected manager and local ids to the table", () => {
  const keys = new VoiceKeys(keybindings());
  assert.equal(keys.matches("\r", "tui.select.confirm"), true);
  assert.equal(keys.matches("\t", "voice.languages.continue"), true);
  assert.equal(keys.matches("\t", "tui.select.confirm"), false);
  assert.deepEqual(keys.keys("tui.select.cancel"), ["escape", "ctrl+c"]);
  assert.equal(keys.keyText(["voice.ratingsHelp.close", "tui.select.cancel"]), "q/escape/ctrl+c");
  assert.equal(keys.navLabel(), "↑↓");
});

test("navigation labels follow rebound pi keys", () => {
  const host = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "ctrl+p",
    "tui.select.down": "ctrl+n",
  });
  const keys = new VoiceKeys(host);
  assert.equal(keys.navLabel(), "ctrl+p/ctrl+n");
  assert.equal(keys.matches(ctrl("p"), "tui.select.up"), true);
  assert.equal(keys.matches(`${ESC}[A`, "tui.select.up"), false);
});

test("voice ids in pi's user bindings override the table defaults", () => {
  const host = new KeybindingsManager(TUI_KEYBINDINGS, {
    "voice.recommendations.browseAll": "b",
    "tui.select.confirm": "ctrl+m",
  });
  const keys = new VoiceKeys(host);
  assert.equal(keys.matches("b", "voice.recommendations.browseAll"), true);
  assert.equal(keys.matches("o", "voice.recommendations.browseAll"), false);
  assert.equal(keys.keyText("voice.recommendations.browseAll"), "b");
  // Unrelated overrides leave the table alone.
  assert.equal(keys.matches("?", "voice.models.ratingsHelp"), true);
});

test("legacy transcribe ids still apply unless the voice id is set", () => {
  const host = new KeybindingsManager(TUI_KEYBINDINGS, {
    "transcribe.recommendations.browseAll": "b",
    "transcribe.tryIt.model": "x",
    "voice.tryIt.model": "y",
  });
  const keys = new VoiceKeys(host);
  assert.equal(keys.keyText("voice.recommendations.browseAll"), "b");
  assert.equal(keys.keyText("voice.tryIt.model"), "y");
  assert.equal(keys.keyText("voice.models.ratingsHelp"), "?");
});
