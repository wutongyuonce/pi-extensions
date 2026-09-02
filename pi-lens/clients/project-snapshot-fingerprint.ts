import { createHash } from "node:crypto";

/**
 * Hash serialized project-snapshot JSON while replacing only the top-level
 * volatile `generatedAt` value with a stable sentinel. Production calls this
 * on the persistence worker after stringify. The main-thread caller uses it
 * only on the explicit synchronous fallback path, where serialization already
 * happened and no second object walk is added.
 */
export function fingerprintProjectSnapshotJson(
	json: string,
	generatedAt: string,
): string {
	const marker = `"generatedAt":${JSON.stringify(generatedAt)}`;
	let markerIndex = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < json.length; index++) {
		const char = json[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			if (depth === 1 && json.startsWith(marker, index)) {
				markerIndex = index;
				break;
			}
			inString = true;
		} else if (char === "{") depth++;
		else if (char === "}") depth--;
	}
	const hash = createHash("sha256");
	if (markerIndex < 0) {
		hash.update(json);
	} else {
		hash.update(json.slice(0, markerIndex));
		hash.update('"generatedAt":""');
		hash.update(json.slice(markerIndex + marker.length));
	}
	return hash.digest("hex");
}
