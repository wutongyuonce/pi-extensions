#!/usr/bin/env node
/**
 * Minimal mock LSP server for lifecycle testing.
 *
 * Speaks JSON-RPC 2.0 over stdin/stdout with LSP Content-Length framing.
 * Handles the standard LSP handshake (initialize → initialized → shutdown/exit)
 * and responds to any request with a null result so the client doesn't hang.
 *
 * Environment variables:
 *   MOCK_LSP_CRASH_AFTER=N   — exit(1) after N messages (simulates a crash)
 *   MOCK_LSP_NO_DIAGNOSTICS  — never publish diagnostics (for timeout tests)
 *   MOCK_LSP_SLOW_INIT_MS=N  — delay the initialize response by N ms
 */

import { Buffer } from "node:buffer";

let readBuf = Buffer.alloc(0);
let msgCount = 0;
const crashAfter = process.env.MOCK_LSP_CRASH_AFTER
	? parseInt(process.env.MOCK_LSP_CRASH_AFTER, 10)
	: Infinity;
const noDiagnostics = !!process.env.MOCK_LSP_NO_DIAGNOSTICS;
const slowInitMs = process.env.MOCK_LSP_SLOW_INIT_MS
	? parseInt(process.env.MOCK_LSP_SLOW_INIT_MS, 10)
	: 0;

/** Write a single LSP message to stdout. */
function send(msg) {
	const body = JSON.stringify(msg);
	const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
	process.stdout.write(header + body);
}

/** Dispatch one parsed LSP message. */
async function handle(msg) {
	msgCount++;
	if (msgCount > crashAfter) {
		process.exit(1);
	}

	if (msg.method === "initialize") {
		if (slowInitMs > 0) await sleep(slowInitMs);
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				capabilities: {
					textDocumentSync: 1,
					hoverProvider: true,
					definitionProvider: true,
					referencesProvider: true,
				},
				serverInfo: { name: "mock-lsp", version: "0.0.0" },
			},
		});
	} else if (msg.method === "shutdown") {
		send({ jsonrpc: "2.0", id: msg.id, result: null });
	} else if (msg.method === "exit") {
		process.exit(0);
	} else if (msg.id !== undefined && msg.id !== null) {
		// Generic request → respond with null so the caller doesn't hang.
		send({ jsonrpc: "2.0", id: msg.id, result: null });
	}

	// After didOpen, publish empty diagnostics (unless suppressed).
	if (!noDiagnostics && msg.method === "textDocument/didOpen") {
		setTimeout(() => {
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri: msg.params?.textDocument?.uri ?? "file:///unknown",
					diagnostics: [],
				},
			});
		}, 10);
	}
}

/** Parse the stdin byte stream, extracting complete LSP messages. */
process.stdin.on("data", (chunk) => {
	readBuf = Buffer.concat([readBuf, chunk]);

	while (true) {
		const sep = readBuf.indexOf("\r\n\r\n");
		if (sep === -1) break;

		const header = readBuf.slice(0, sep).toString("utf8");
		const m = header.match(/Content-Length:\s*(\d+)/i);
		if (!m) break;

		const bodyLen = parseInt(m[1], 10);
		const bodyStart = sep + 4;
		if (readBuf.length < bodyStart + bodyLen) break;

		const body = readBuf.slice(bodyStart, bodyStart + bodyLen).toString("utf8");
		readBuf = readBuf.slice(bodyStart + bodyLen);

		try {
			handle(JSON.parse(body));
		} catch {
			/* ignore malformed messages */
		}
	}
});

process.stdin.on("end", () => process.exit(0));

// Suppress write errors (stdout may close when the test kills the process).
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("error", () => {});

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
