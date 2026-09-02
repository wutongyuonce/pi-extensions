import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { runBtwFullscreen } from "../src/fullscreen-ui.js";
import { BtwAnsweringView, BtwTranscriptPager } from "../src/transcript-pager.js";

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "test",
		model: "side",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

function createFullscreenHarness(rows = 12) {
	const writes: string[] = [];
	let handleInput: ((data: string) => void) | undefined;
	const terminal = {
		columns: 80,
		rows,
		start(onInput: (data: string) => void) {
			handleInput = onInput;
		},
		stop() {},
		write(data: string) {
			writes.push(data);
		},
		hideCursor() {},
		showCursor() {},
	} as never;
	const parent = {
		mode: "regular",
		terminal,
		getShowHardwareCursor: () => false,
		stop() {},
		start() {},
		renderNow() {},
		requestRender() {},
	} as unknown as TUI;
	let outerDone: ((value: unknown) => void) | undefined;
	let editorText = "main draft";
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => Component) => {
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				factory(
					parent as never,
					{ fg: (_color: string, text: string) => text } as never,
					{} as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				return result;
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;
	return {
		ctx,
		writes,
		get input() {
			assert.ok(handleInput);
			return handleInput;
		},
	};
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("mouse wheel and history keys scroll the native side-thread viewport", async () => {
	initTheme("dark");
	const harness = createFullscreenHarness();
	const answer = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
	let sideTui: TUI | undefined;
	const running = runBtwFullscreen(harness.ctx, (fullscreenCtx) =>
		fullscreenCtx.ui.custom<"closed">((tui, theme, _keys, done) => {
			sideTui = tui;
			return new BtwTranscriptPager(
				tui,
				theme,
				[{ question: "question", answer, kind: "answered", response: response(answer) }],
				(action) => {
					if (action.kind === "close") done("closed");
				},
				{ startAtBottom: true },
			);
		}),
	);
	await flushAsyncWork();
	assert.ok(sideTui);

	sideTui.renderNow(true);
	const viewport = sideTui as TuiAltScreen;
	const initialTop = viewport.viewportTop;
	assert.ok(initialTop > 0, "long transcript should use the native primary scroll viewport");

	harness.writes.length = 0;
	harness.input("\u001b[<64;1;1M");
	sideTui.renderNow(true);
	const wheelOlderTop = viewport.viewportTop;
	assert.ok(
		wheelOlderTop < initialTop,
		"wheel-up over the fixed header should reveal older history",
	);
	const wheelFrame = stripVTControlCharacters(harness.writes.join(""));
	assert.match(wheelFrame, /btw · side thread/);
	assert.match(wheelFrame, /Ctrl\+C/);
	assert.match(wheelFrame, /PgUp\/PgDn/);

	harness.input("\u001b[<65;1;1M");
	sideTui.renderNow(true);
	assert.ok(viewport.viewportTop > wheelOlderTop, "wheel-down should reveal newer history");

	const beforePageUp = viewport.viewportTop;
	harness.input("\u001b[5~");
	sideTui.renderNow(true);
	const pageOlderTop = viewport.viewportTop;
	assert.ok(pageOlderTop < beforePageUp, "PageUp should use the same primary transcript viewport");
	harness.input("\u001b[6~");
	sideTui.renderNow(true);
	assert.ok(viewport.viewportTop > pageOlderTop, "PageDown should return toward newer history");

	harness.input("\u0003");
	assert.equal(await running, "closed");
});

test("mouse wheel scrolls transcript history while an answer and composer stay visible", async () => {
	initTheme("dark");
	const harness = createFullscreenHarness(14);
	const answer = Array.from({ length: 40 }, (_, index) => `earlier ${index + 1}`).join("\n");
	let sideTui: TUI | undefined;
	const running = runBtwFullscreen(harness.ctx, (fullscreenCtx) =>
		fullscreenCtx.ui.custom<"cancelled">((tui, theme, _keys, done) => {
			sideTui = tui;
			return new BtwAnsweringView(
				tui,
				theme,
				[
					{
						question: "earlier question",
						answer,
						kind: "answered",
						response: response(answer),
					},
				],
				"current question",
				() => done("cancelled"),
				undefined,
				{ steering: { questions: [], onSubmit() {} } },
			);
		}),
	);
	await flushAsyncWork();
	assert.ok(sideTui);

	sideTui.renderNow(true);
	const viewport = sideTui as TuiAltScreen;
	const initialTop = viewport.viewportTop;
	assert.ok(initialTop > 0);
	harness.writes.length = 0;
	harness.input("\u001b[<64;1;1M");
	sideTui.renderNow(true);
	assert.ok(viewport.viewportTop < initialTop);
	const wheelFrame = stripVTControlCharacters(harness.writes.join(""));
	assert.match(wheelFrame, /btw · side thread/);
	assert.match(wheelFrame, /Answering…/);
	assert.match(wheelFrame, /Ctrl\+C/);

	harness.input("\u0003");
	assert.equal(await running, "cancelled");
});
