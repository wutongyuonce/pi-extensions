#!/usr/bin/env node

import { gguf } from "@huggingface/gguf";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const path = resolve(scriptDirectory, "../catalog/catalog.json");
const catalog = JSON.parse(await readFile(path, "utf8"));
const token = process.env.HF_TOKEN?.trim();
const additionalFetchHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;

for (const model of catalog.models) {
  const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${encodeURIComponent(model.filename)}`;
  const { metadata } = await gguf(url, { additionalFetchHeaders });
  const languages = metadata["general.languages"];
  if (!Array.isArray(languages) || !languages.every((value) => typeof value === "string")) {
    throw new Error(`${model.id}: general.languages is missing or invalid`);
  }
  if (new Set(languages).size !== languages.length) {
    throw new Error(`${model.id}: general.languages contains duplicates`);
  }

  model.languages = languages;
  console.error(`✓ ${model.id} · ${languages.length} language${languages.length === 1 ? "" : "s"}`);
}

await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
console.error(`Updated ${path}`);
