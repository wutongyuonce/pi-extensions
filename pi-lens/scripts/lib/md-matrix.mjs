// Shared merge helpers for the LSP capability docs (#390). The nightly runs on
// ubuntu-latest, which lacks many language toolchains, so a naive overwrite would
// DROP rows a richer run (e.g. the dev box) captured. These helpers MERGE: a row
// the current run measured is updated in place; a row it didn't measure (server
// unavailable/unknown here) is preserved verbatim. Server-row count never
// shrinks. Used by characterize-lsp.mjs + probe-clean-signal.mjs (which share
// docs/lsp-capability-matrix.md) and server-capabilities.mjs. #460/#390.

/**
 * Parse a GitHub-flavoured Markdown table into { header, aligns, rows } where
 * rows is an array of cell-string arrays. Only the FIRST table after `afterLine`
 * (a line whose text includes the marker) is parsed. Returns null if not found.
 *
 * @param {string} text
 * @param {string} headerMarker  a substring of the table's header row (e.g. "| lang | server |")
 * @returns {{ start: number, end: number, header: string[], sep: string, rows: string[][] } | null}
 */
export function parseTable(text, headerMarker) {
	const lines = text.split("\n");
	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(headerMarker) && lines[i].trim().startsWith("|")) {
			headerIdx = i;
			break;
		}
	}
	if (headerIdx < 0 || headerIdx + 1 >= lines.length) return null;
	const sepIdx = headerIdx + 1;
	if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[sepIdx])) return null;
	const header = splitRow(lines[headerIdx]);
	const rows = [];
	let end = sepIdx + 1;
	for (let i = sepIdx + 1; i < lines.length; i++) {
		if (!lines[i].trim().startsWith("|")) break;
		rows.push(splitRow(lines[i]));
		end = i + 1;
	}
	return { start: headerIdx, end, header, sep: lines[sepIdx], rows };
}

function splitRow(line) {
	// Strip leading/trailing pipe then split; trim each cell.
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((c) => c.trim());
}

function renderRow(cells) {
	return `| ${cells.join(" | ")} |`;
}

/**
 * Merge measured rows into an existing table's rows, keyed by a column index.
 * For each measured row, only the columns named in `ownedCols` are overwritten
 * (so two scripts sharing a table each update only their own columns); unlisted
 * columns keep the existing value. Rows present in the doc but NOT measured this
 * run are preserved. New servers are appended.
 *
 * @param {string[][]} existing   parsed existing rows
 * @param {string[]} header       column headers (for name→index)
 * @param {Object[]} measured     objects keyed by header name → cell value
 * @param {string} keyCol         header name of the unique key (e.g. "lang")
 * @param {string[]} ownedCols    header names this run is authoritative for
 * @param {{ updateOnly?: boolean }} [opts]  when updateOnly, a measured key with
 *   no existing row is DROPPED (the matrix is curated — new langs are added by
 *   hand, not appended by a probe). Default appends new keys.
 * @returns {string[][]}          merged rows
 */
export function mergeRows(
	existing,
	header,
	measured,
	keyCol,
	ownedCols,
	opts = {},
) {
	const idx = (name) => header.indexOf(name);
	const keyIdx = idx(keyCol);
	const byKey = new Map();
	const order = [];
	for (const cells of existing) {
		const k = cells[keyIdx];
		byKey.set(k, [...cells]);
		order.push(k);
	}
	for (const m of measured) {
		const k = m[keyCol];
		let cells = byKey.get(k);
		if (!cells) {
			if (opts.updateOnly) continue; // don't append to a curated table
			cells = header.map((h) => (m[h] !== undefined ? String(m[h]) : ""));
			byKey.set(k, cells);
			order.push(k);
			continue;
		}
		for (const col of ownedCols) {
			const ci = idx(col);
			if (ci >= 0 && m[col] !== undefined) cells[ci] = String(m[col]);
		}
	}
	return order.map((k) => byKey.get(k));
}

/**
 * Merge a measured `src` token (e.g. "ci") into an existing one (e.g. "dev") so a
 * row measured on both surfaces reads "dev+ci". Order kept deterministic
 * (dev before ci). An empty/missing existing value just yields the new token.
 *
 * @param {string} existing
 * @param {string} measured
 * @returns {string}
 */
export function mergeSrc(existing, measured) {
	const set = new Set();
	for (const part of String(existing ?? "").split("+")) {
		const t = part.trim();
		if (t && t !== "—") set.add(t);
	}
	if (measured) set.add(measured.trim());
	const order = ["dev", "ci"];
	return [...set]
		.sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
		})
		.join("+");
}

/**
 * Replace the table located by `headerMarker` in `text` with a table built from
 * `header`/`sep`/`rows`. If no such table exists, returns null (caller decides
 * whether to append a fresh table). Preserves everything outside the table.
 *
 * @returns {string | null}
 */
export function replaceTable(text, headerMarker, header, sep, rows) {
	const tbl = parseTable(text, headerMarker);
	if (!tbl) return null;
	const lines = text.split("\n");
	const rendered = [renderRow(header), sep, ...rows.map(renderRow)];
	lines.splice(tbl.start, tbl.end - tbl.start, ...rendered);
	return lines.join("\n");
}

/**
 * Merge prior rows into a NEW header shape by column NAME, tolerating a schema
 * change between the prior doc and this run (#469). Unlike `mergeRows` (which
 * requires identical headers), this reshapes each prior row that this run did
 * NOT capture onto `newHeader`: columns present in both are carried by name,
 * columns the prior row lacked (a column added this run) are filled with
 * `placeholder`, and columns dropped from the new schema are simply not
 * carried. Rows this run DID capture are the caller's fresh rows and always
 * win — pass only the prior rows NOT in `capturedKeys` as `priorRows`.
 *
 * @param {string[][]} priorRows     prior rows to reshape (already narrowed to
 *   the ones this run did not capture), in `priorHeader` column order
 * @param {string[]} priorHeader     the prior doc's header
 * @param {string[]} newHeader       this run's header (may differ in columns)
 * @param {string} keyCol            header name of the unique row key (e.g. "server")
 * @param {string} [placeholder]     fill value for columns the prior row lacked
 * @returns {string[][]}             priorRows reshaped onto newHeader
 */
export function reshapeRowsByName(
	priorRows,
	priorHeader,
	newHeader,
	keyCol,
	placeholder = "·",
) {
	const priorIdx = (name) => priorHeader.indexOf(name);
	return priorRows.map((cells) =>
		newHeader.map((h) => {
			const pi = priorIdx(h);
			if (pi >= 0 && cells[pi] !== undefined) return cells[pi];
			if (h === keyCol) return cells[priorIdx(keyCol)] ?? "";
			return placeholder;
		}),
	);
}

/**
 * Parse a `## heading` bulleted-list section (lines of the form
 * `- **<key>**: <rest>`) into an ordered Map of key → full bullet line
 * (without the leading `- `). Stops at the next `## ` heading or EOF. Returns
 * an empty Map if the section isn't found — callers treat that as "nothing to
 * carry over", never a crash.
 *
 * @param {string} text
 * @param {string} heading   e.g. "## Raw advertised capability keys"
 * @returns {Map<string, string>}
 */
export function parseBulletSection(text, heading) {
	const lines = text.split("\n");
	const map = new Map();
	let i = lines.findIndex((l) => l.trim() === heading.trim());
	if (i < 0) return map;
	i++;
	// The bold key is followed by either `:` (Raw advertised capability keys)
	// or ` (N):` (Advertised executeCommand allowlists, N = allowlist size) —
	// tolerate both so a single parser/merger works for both sections.
	const bulletRe = /^- \*\*(.+?)\*\*(?:\s*\([^)]*\))?:\s*(.*)$/;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) break;
		const m = bulletRe.exec(line);
		if (m) map.set(m[1], line.replace(/^- /, ""));
	}
	return map;
}

/**
 * Merge preserved-server bullets into a freshly-generated `## heading` section
 * of `newText`, carrying over the prior doc's bullet line for each key in
 * `keysToCarry` that has one (silently skipped if the prior doc had none for
 * that key). The merged section is re-sorted by key so preserved and freshly-
 * generated bullets interleave alphabetically, matching the generator's
 * existing sort. If `heading` isn't found in `newText`, returns `newText`
 * unchanged (fail-open — never crash the nightly over a missing section).
 *
 * @param {string} newText
 * @param {string} heading
 * @param {Map<string, string>} priorBullets   from `parseBulletSection` on the prior doc
 * @param {string[]} keysToCarry               keys (servers) to pull from `priorBullets`
 * @returns {string}
 */
export function mergeBulletSection(
	newText,
	heading,
	priorBullets,
	keysToCarry,
) {
	const lines = newText.split("\n");
	const headingIdx = lines.findIndex((l) => l.trim() === heading.trim());
	if (headingIdx < 0) return newText;
	// The section body starts after the heading, skipping a single blank line
	// (the generator always emits one), and runs up to the next `## ` heading
	// or EOF.
	const bodyStart =
		lines[headingIdx + 1] === "" ? headingIdx + 2 : headingIdx + 1;
	let bodyEnd = lines.length;
	for (let i = bodyStart; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			bodyEnd = i;
			break;
		}
	}
	// The bold key is followed by either `:` (Raw advertised capability keys)
	// or ` (N):` (Advertised executeCommand allowlists, N = allowlist size) —
	// tolerate both so a single parser/merger works for both sections.
	const bulletRe = /^- \*\*(.+?)\*\*(?:\s*\([^)]*\))?:\s*(.*)$/;
	const byKey = new Map();
	// Trailing non-bullet lines within the body (e.g. a blank line at EOF when
	// this is the last section) — preserved after the sorted bullets rather than
	// dropped.
	const trailing = [];
	for (let i = bodyStart; i < bodyEnd; i++) {
		const m = bulletRe.exec(lines[i]);
		if (m) byKey.set(m[1], lines[i]);
		else trailing.push(lines[i]);
	}
	let added = false;
	for (const k of keysToCarry) {
		if (byKey.has(k)) continue; // captured this run — always wins
		const prior = priorBullets.get(k);
		if (prior === undefined) continue; // prior doc had no bullet — skip silently
		byKey.set(k, `- ${prior}`);
		added = true;
	}
	if (!added) return newText;
	const sortedLines = [...byKey.keys()]
		.sort((a, b) => a.localeCompare(b))
		.map((k) => byKey.get(k));
	const before = lines.slice(0, bodyStart);
	const after = lines.slice(bodyEnd);
	return [...before, ...sortedLines, ...trailing, ...after].join("\n");
}

// Deliberately a SHORT, schema-stable marker (not "| server | mode | ws-pull |")
// — the whole point of #469 is that a prior doc predating the ws-pull column
// must still be found and parsed, so the marker can't assume a column that
// might not exist yet.
const SERVER_CAPS_TABLE_MARKER = "| server | mode |";
const SERVER_CAPS_RAW_KEYS_HEADING = "## Raw advertised capability keys";
const SERVER_CAPS_EXEC_CMDS_HEADING = "## Advertised executeCommand allowlists";

/**
 * Merge a prior `docs/servercapabilities.md` into a freshly-generated one
 * (#390/#469): servers the fresh run didn't capture keep their prior table
 * row (reshaped by column NAME onto the fresh header via `reshapeRowsByName`,
 * so a schema change like the ws-pull column addition no longer disables the
 * guard — #469) and their bullet lines in both "Raw advertised capability
 * keys" and "Advertised executeCommand allowlists" (via `mergeBulletSection`,
 * which the original #390 guard didn't touch at all). Servers captured this
 * run always win — their fresh row/bullets are never overwritten by a stale
 * prior value.
 *
 * Pure (text in, text in, text out) so it's testable without spawning any LSP
 * server. Fail-open: if either doc's table is unparseable, returns the fresh
 * text unchanged (caller logs the skip; the nightly must never crash on this).
 *
 * @param {string} priorText   previous docs/servercapabilities.md content
 * @param {string} freshText   this run's freshly-generated content
 * @returns {{ text: string, preservedCount: number }}
 */
export function mergeServerCapabilitiesDoc(priorText, freshText) {
	const priorTbl = parseTable(priorText, SERVER_CAPS_TABLE_MARKER);
	const newTbl = parseTable(freshText, SERVER_CAPS_TABLE_MARKER);
	if (!priorTbl || !newTbl) {
		return { text: freshText, preservedCount: 0 };
	}
	const keyIdx = newTbl.header.indexOf("server");
	const priorKeyIdx = priorTbl.header.indexOf("server");
	if (keyIdx < 0 || priorKeyIdx < 0) {
		return { text: freshText, preservedCount: 0 };
	}
	const capturedKeys = new Set(newTbl.rows.map((c) => c[keyIdx]));
	const notCapturedPriorRows = priorTbl.rows.filter(
		(c) => !capturedKeys.has(c[priorKeyIdx]),
	);
	const reshaped = reshapeRowsByName(
		notCapturedPriorRows,
		priorTbl.header,
		newTbl.header,
		"server",
	);
	const mergedRows = [...newTbl.rows, ...reshaped].sort((a, b) =>
		a[keyIdx].localeCompare(b[keyIdx]),
	);
	let text = replaceTable(
		freshText,
		SERVER_CAPS_TABLE_MARKER,
		newTbl.header,
		newTbl.sep,
		mergedRows,
	);
	if (!text) {
		return { text: freshText, preservedCount: 0 };
	}
	const preservedServers = notCapturedPriorRows.map((c) => c[priorKeyIdx]);
	for (const heading of [
		SERVER_CAPS_RAW_KEYS_HEADING,
		SERVER_CAPS_EXEC_CMDS_HEADING,
	]) {
		const priorBullets = parseBulletSection(priorText, heading);
		text = mergeBulletSection(text, heading, priorBullets, preservedServers);
	}
	return { text, preservedCount: preservedServers.length };
}
