import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFileAudio } from "../src/file-audio.js";

const NEW_VARIABLE = "PI_VOICE_FFMPEG_PATH";
const LEGACY_VARIABLE = "PI_TRANSCRIBE_FFMPEG_PATH";

test("the new FFmpeg path takes precedence and the legacy path remains a fallback", async (t) => {
  const previousNew = process.env[NEW_VARIABLE];
  const previousLegacy = process.env[LEGACY_VARIABLE];
  t.after(() => {
    if (previousNew === undefined) delete process.env[NEW_VARIABLE];
    else process.env[NEW_VARIABLE] = previousNew;
    if (previousLegacy === undefined) delete process.env[LEGACY_VARIABLE];
    else process.env[LEGACY_VARIABLE] = previousLegacy;
  });

  process.env[NEW_VARIABLE] = `missing-pi-voice-ffmpeg-${process.pid}`;
  process.env[LEGACY_VARIABLE] = `missing-pi-transcribe-ffmpeg-${process.pid}`;
  await assert.rejects(decodeFileAudio("unused"), new RegExp(NEW_VARIABLE));

  delete process.env[NEW_VARIABLE];
  await assert.rejects(decodeFileAudio("unused"), new RegExp(LEGACY_VARIABLE));
});
