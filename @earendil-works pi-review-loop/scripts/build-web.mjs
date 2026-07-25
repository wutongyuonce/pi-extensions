import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outdir = new URL("../web/dist/", import.meta.url);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: ["web/src/app.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "web/dist/app.js",
  sourcemap: false,
  minify: true,
  loader: { ".ttf": "dataurl", ".png": "dataurl", ".svg": "dataurl" },
});

await build({
  entryPoints: ["node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "web/dist/editor.worker.js",
  minify: true,
});

const [template, monacoStyles, appStyles, appSource, workerSource, codiconCss, codiconFont] = await Promise.all([
  readFile(new URL("../web/src/index.html", import.meta.url), "utf8"),
  readFile(new URL("app.css", outdir), "utf8"),
  readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("app.js", outdir), "utf8"),
  readFile(new URL("editor.worker.js", outdir), "utf8"),
  readFile(new URL("../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css", import.meta.url), "utf8"),
  readFile(new URL("../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf", import.meta.url)),
]);

const base64 = (source) => Buffer.from(source, "utf8").toString("base64");
const codiconStyles = codiconCss.replace("./codicon.ttf", `data:font/ttf;base64,${codiconFont.toString("base64")}`);
const html = template
  .replace("__MONACO_STYLES_BASE64__", base64(`${codiconStyles}\n${monacoStyles}`))
  .replace("__APP_STYLES_BASE64__", base64(appStyles))
  .replace("__WORKER_SOURCE_BASE64__", base64(workerSource))
  .replace("__APP_SOURCE_BASE64__", base64(appSource));
await writeFile(new URL("index.html", outdir), html, "utf8");
