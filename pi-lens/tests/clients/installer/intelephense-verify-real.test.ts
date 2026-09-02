import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { verifyToolBinary } from "../../../clients/installer/index.js";

const binaryCandidates = [
	path.join(
		os.homedir(),
		".pi-lens",
		"tools",
		"node_modules",
		".bin",
		"intelephense",
	),
];
const binaryPath = binaryCandidates.find((candidate) =>
	fs.existsSync(`${candidate}${process.platform === "win32" ? ".cmd" : ""}`),
);

describe("intelephense verification output retention", () => {
	it.skipIf(!binaryPath)(
		"recognizes the transport rescue in the tail under the production cap",
		async () => {
			expect(
				await verifyToolBinary(binaryPath!, undefined, undefined, 10000, [
					"--version",
				]),
			).toBe(true);
		},
		15000,
	);
});
