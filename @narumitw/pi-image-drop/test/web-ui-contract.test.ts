import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const packageRoot = path.join(process.cwd(), "extensions/pi-image-drop");
const webRoot = path.join(packageRoot, "src/web");
const [manifestSource, html, appSource, componentsSource, stylesSource, buildSource] =
	await Promise.all([
		readFile(path.join(packageRoot, "package.json"), "utf8"),
		readFile(path.join(webRoot, "index.html"), "utf8"),
		readFile(path.join(webRoot, "ui/app.tsx"), "utf8").catch(() => ""),
		readFile(path.join(webRoot, "ui/components.tsx"), "utf8").catch(() => ""),
		readFile(path.join(webRoot, "ui/styles.css"), "utf8").catch(() => ""),
		readFile(path.join(packageRoot, "scripts/build-web.mjs"), "utf8").catch(() => ""),
	]);
const manifest = JSON.parse(manifestSource);
const browserSource = `${appSource}\n${componentsSource}`;

test("browser source uses React, TypeScript, and the complete Radix UI stack", () => {
	const bundleDependencies = {
		"@radix-ui/colors": "3.0.0",
		"@radix-ui/react-icons": "1.3.2",
		"@radix-ui/themes": "3.3.0",
		"radix-ui": "1.6.7",
		react: "19.2.8",
		"react-dom": "19.2.8",
	};
	for (const [dependency, version] of Object.entries(bundleDependencies)) {
		assert.equal(manifest.dependencies?.[dependency], version, dependency);
	}
	assert.equal(manifest.devDependencies?.esbuild, "0.28.1");
	assert.match(appSource, /from "@radix-ui\/themes"/);
	assert.match(browserSource, /from "@radix-ui\/react-icons"/);
	assert.match(browserSource, /from "radix-ui"/);
	assert.match(appSource, /from "react"/);
	assert.match(appSource, /from "react-dom\/client"/);
});

test("HTML is a minimal authenticated React shell with the existing local asset URLs", () => {
	assert.match(html, /id="root"/);
	assert.match(html, /name="csp-nonce" content="__PI_CSP_NONCE__"/);
	assert.match(html, /href="\/styles\.css"/);
	assert.match(html, /src="\/app\.js"/);
	assert.doesNotMatch(html, /<(?:button|input|dialog|details|summary|main)\b/);
});

test("Radix primitives own disclosures and dialogs without unsafe HTML", () => {
	for (const primitive of ["AlertDialog", "Collapsible", "Dialog"]) {
		assert.match(browserSource, new RegExp(`${primitive}\\.`), primitive);
	}
	assert.doesNotMatch(browserSource, /dangerouslySetInnerHTML|innerHTML|document\.write/);
	assert.equal(browserSource.match(/<AlertDialog\.Title asChild>/g)?.length, 2);
	assert.equal(browserSource.match(/<AlertDialog\.Description asChild>/g)?.length, 2);
	assert.match(browserSource, /<Dialog\.Title asChild>/);
});

test("visible labels preserve staging, history, retry, reorder, and destructive paths", () => {
	for (const label of [
		"Choose images",
		"Add again",
		"Clear all",
		"Clear history",
		"Delete",
		"Retry",
		"Move backward",
		"Move forward",
	]) {
		assert.match(browserSource, new RegExp(label));
	}
	assert.equal(
		browserSource.match(/Sensitive image metadata removed from processed images\./g)?.length,
		1,
	);
	assert.equal(browserSource.match(/visibleItemNotes\(item\.notes\)/g)?.length, 2);
});

test("custom states use Radix light and dark colors with responsive accessibility", () => {
	assert.match(stylesSource, /@radix-ui\/themes\/styles\.css/);
	assert.match(stylesSource, /@radix-ui\/colors\/jade\.css/);
	assert.match(stylesSource, /@radix-ui\/colors\/jade-dark\.css/);
	assert.match(stylesSource, /@radix-ui\/colors\/red\.css/);
	assert.match(stylesSource, /@radix-ui\/colors\/red-dark\.css/);
	assert.match(stylesSource, /var\(--jade-9\)/);
	assert.match(stylesSource, /var\(--red-9\)/);
	assert.match(stylesSource, /min-height:\s*44px/);
	assert.match(stylesSource, /:focus-visible/);
	assert.match(stylesSource, /repeat\(auto-fit,\s*minmax\(min\(100%,\s*245px\),\s*1fr\)\)/);
	assert.match(stylesSource, /\.image-card:only-child\s*\{[\s\S]*max-width:/);
	assert.match(stylesSource, /@media \(max-width:\s*(?:620|640)px\)/);
	assert.match(stylesSource, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test("the local build emits and freshness-checks every authenticated browser asset", () => {
	assert.equal(manifest.scripts?.["build:web"], "node scripts/build-web.mjs");
	assert.equal(manifest.scripts?.["check:web"], "node scripts/build-web.mjs --check");
	for (const asset of ["app.js", "state.js", "styles.css"]) {
		assert.match(buildSource, new RegExp(asset.replace(".", "\\.")));
	}
	assert.match(buildSource, /mkdtemp/);
	assert.match(buildSource, /__webpack_nonce__/);
	assert.match(buildSource, /stale/);
});
