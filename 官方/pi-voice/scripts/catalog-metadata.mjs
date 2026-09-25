#!/usr/bin/env node

// Check catalog language metadata against each model's GGUF header, or
// rewrite the catalog from the headers with --write.

import { gguf } from "@huggingface/gguf";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const write = process.argv.includes("--write");
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const path = resolve(scriptDirectory, "../catalog/catalog.json");
const catalog = JSON.parse(await readFile(path, "utf8"));
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
    if (write) {
      model.languages = languages;
    } else if (JSON.stringify(languages) !== JSON.stringify(model.languages)) {
      throw new Error(
        `catalog languages ${JSON.stringify(model.languages)} do not match GGUF ${JSON.stringify(languages)}`,
      );
    }
    console.error(`✓ ${model.id} · ${languages.length} language${languages.length === 1 ? "" : "s"}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${model.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} catalog check${failures === 1 ? "" : "s"} failed`);
}
if (write) {
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
  console.error(`Updated ${path}`);
}
