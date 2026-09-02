#!/usr/bin/env node

import { gguf } from "@huggingface/gguf";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  await readFile(resolve(scriptDirectory, "../catalog/catalog.json"), "utf8"),
);
const token = process.env.HF_TOKEN?.trim();
const additionalFetchHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
let failures = 0;

for (const model of catalog.models) {
  const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${encodeURIComponent(model.filename)}`;
  try {
    const { metadata } = await gguf(url, { additionalFetchHeaders });
    const languages = metadata["general.languages"];
    if (!Array.isArray(languages) || !languages.every((value) => typeof value === "string")) {
      throw new Error("general.languages is missing or is not an array of strings");
    }
    if (new Set(languages).size !== languages.length) {
      throw new Error("general.languages contains duplicates");
    }
    if (JSON.stringify(languages) !== JSON.stringify(model.languages)) {
      throw new Error(
        `catalog languages ${JSON.stringify(model.languages)} do not match GGUF ${JSON.stringify(languages)}`,
      );
    }
    console.error(`✓ ${model.id} · ${model.quant}`);
  } catch (error) {
    failures += 1;
    console.error(
      `✗ ${model.id} · ${model.quant}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures > 0) {
  throw new Error(`${failures} catalog verification${failures === 1 ? "" : "s"} failed`);
}
