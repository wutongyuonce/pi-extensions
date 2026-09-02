import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;

async function runOversizeProbe(expression) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-oversize-video-"));
	const videoPath = join(root, "oversized.mp4");
	await writeFile(videoPath, "");
	await truncate(videoPath, 50 * 1024 * 1024 + 1);
	try {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(root)};
				const { extractContent } = await import(${JSON.stringify(extractUrl)});
				const result = await (${expression})(extractContent, ${JSON.stringify(videoPath)});
				console.log(JSON.stringify({ title: result.title, content: result.content, error: result.error }));
			`,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("oversized local videos are still recognized for frame extraction", async () => {
	const result = await runOversizeProbe(`(extractContent, videoPath) => extractContent(videoPath, undefined, { frames: 1 })`);

	assert.notEqual(result.error, "Frame extraction only works with YouTube and local video files");
	assert.match(result.error, /ffprobe|Cannot determine video duration|failed|not installed/i);
});

test("oversized local videos are still recognized for timestamp extraction", async () => {
	const result = await runOversizeProbe(`(extractContent, videoPath) => extractContent(videoPath, undefined, { timestamp: "1" })`);

	assert.notEqual(result.error, "Timestamp extraction only works with YouTube and local video files");
	assert.match(result.error, /ffmpeg|failed|not installed/i);
});

test("oversized local video analysis reports the upload size limit", async () => {
	const result = await runOversizeProbe(`(extractContent, videoPath) => extractContent(videoPath, undefined, { prompt: "summarize" })`);

	assert.match(result.error, /above configured video\.maxSizeMB/);
	assert.match(result.error, /timestamp\/frames/);
});
