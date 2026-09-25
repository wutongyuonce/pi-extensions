import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findPiLensProjectConfig,
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "./test-utils.js";

// #1333: these config/telemetry warnings no longer reach the terminal — pi owns
// it — they go to the ndjson sink in `clients/extension-log.ts`. The sink mock
// below forwards each entry's message to `console.error` so the assertions in
// this file keep covering what they were written to cover (message content and
// the warn-once dedup contract) without re-deriving every expectation. The
// "no raw terminal write" half of the invariant is enforced repo-wide by
// tests/clients/extension-terminal-silence.test.ts.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-config-"));
	resetProjectLensConfigCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	resetProjectLensConfigCache();
	vi.restoreAllMocks();
});

describe("loadPiLensProjectConfig", () => {
	it("returns empty config when no file exists", () => {
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual([]);
		expect(cfg.rules).toEqual({});
		expect(cfg.configPath).toBeUndefined();
		expect(cfg.raw).toBeUndefined();
	});

	it("loads .pi-lens.json from cwd", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				ignore: ["**/__tests__/**", "fixtures/**"],
				rules: { "high-complexity": { threshold: 25 } },
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["**/__tests__/**", "fixtures/**"]);
		expect(cfg.rules["high-complexity"]?.threshold).toBe(25);
		expect(cfg.configPath).toBe(path.join(tmpDir, ".pi-lens.json"));
	});

	it("parses project-level mutation controls", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				format: { enabled: false },
				autofix: { enabled: false },
				actionableWarnings: { autoFix: { enabled: false } },
			}),
		);

		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.format).toEqual({ enabled: false });
		expect(cfg.autofix).toEqual({ enabled: false });
		expect(cfg.actionableWarnings).toEqual({
			autoFix: { enabled: false },
		});
	});

	it("ignores invalid project-level mutation controls", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				format: { enabled: "no" },
				autofix: false,
				actionableWarnings: { autoFix: { enabled: 1 } },
			}),
		);

		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.format?.enabled).toBeUndefined();
		expect(cfg.autofix).toBeUndefined();
		expect(cfg.actionableWarnings?.autoFix?.enabled).toBeUndefined();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("format.enabled must be a boolean"),
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("autofix must be an object"),
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"actionableWarnings.autoFix.enabled must be a boolean",
			),
		);
	});

	it("accepts pi-lens.json (no leading dot) as a fallback name", () => {
		fs.writeFileSync(
			path.join(tmpDir, "pi-lens.json"),
			JSON.stringify({ ignore: ["vendor/**"] }),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["vendor/**"]);
		expect(cfg.configPath).toBe(path.join(tmpDir, "pi-lens.json"));
	});

	it("prefers .pi-lens.json over pi-lens.json when both exist", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["dotfile-wins/**"] }),
		);
		fs.writeFileSync(
			path.join(tmpDir, "pi-lens.json"),
			JSON.stringify({ ignore: ["nodot/**"] }),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["dotfile-wins/**"]);
	});

	it("walks up to find a config in a parent directory", () => {
		const sub = path.join(tmpDir, "src", "lib");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["upward/**"] }),
		);
		const cfg = loadPiLensProjectConfig(sub);
		expect(cfg.ignore).toEqual(["upward/**"]);
		expect(cfg.configPath).toBe(path.join(tmpDir, ".pi-lens.json"));
	});

	it("invalidates the cache when the file mtime changes", async () => {
		const p = path.join(tmpDir, ".pi-lens.json");
		fs.writeFileSync(p, JSON.stringify({ ignore: ["a"] }));
		const cfg1 = loadPiLensProjectConfig(tmpDir);
		expect(cfg1.ignore).toEqual(["a"]);

		// Sleep is the only portable way to guarantee mtime advances across
		// filesystems; 20ms is well above the 1ms resolution of every modern FS.
		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(p, JSON.stringify({ ignore: ["b", "c"] }));
		const cfg2 = loadPiLensProjectConfig(tmpDir);
		expect(cfg2.ignore).toEqual(["b", "c"]);
	});

	it("returns empty config on malformed JSON without throwing", () => {
		fs.writeFileSync(path.join(tmpDir, ".pi-lens.json"), "{not json");
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual([]);
		expect(cfg.configPath).toBeUndefined();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("ignoring invalid project config"),
		);
	});

	it("returns empty config when root is a non-object JSON value", () => {
		fs.writeFileSync(path.join(tmpDir, ".pi-lens.json"), '"a string"');
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual([]);
		expect(cfg.configPath).toBeUndefined();
	});

	it("filters non-string entries out of the ignore array", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				ignore: ["valid/**", 42, null, "also-valid/**", true, { x: 1 }],
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.ignore).toEqual(["valid/**", "also-valid/**"]);
	});

	it("rejects non-positive and non-finite threshold numbers", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": { threshold: NaN },
					"high-fan-out": { threshold: Infinity },
					"high-import-coupling": { threshold: -Infinity },
					"cors-wildcard": { threshold: "15" },
					"zero-threshold": { threshold: 0 },
					"negative-threshold": { threshold: -5 },
				},
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("threshold must be a positive finite number"),
		);
		expect(cfg.rules["high-complexity"]).toBeUndefined();
		expect(cfg.rules["high-fan-out"]).toBeUndefined();
		expect(cfg.rules["high-import-coupling"]).toBeUndefined();
		expect(cfg.rules["cors-wildcard"]).toBeUndefined();
		expect(cfg.rules["zero-threshold"]).toBeUndefined();
		expect(cfg.rules["negative-threshold"]).toBeUndefined();
	});

	it("ignores non-object rule entries and entries with no threshold", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": "not an object",
					"high-fan-out": null,
					"good-rule": [],
					// Valid object but no threshold key — no actionable override,
					// so we skip it (forward-compat: future rule keys may have
					// sub-keys we don't know about yet, and we don't want to
					// claim support we can't deliver).
					"cors-wildcard": { unrelated: true },
				},
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.rules["high-complexity"]).toBeUndefined();
		expect(cfg.rules["high-fan-out"]).toBeUndefined();
		expect(cfg.rules["good-rule"]).toBeUndefined();
		expect(cfg.rules["cors-wildcard"]).toBeUndefined();
	});

	it("preserves rule entries that have a finite threshold alongside other keys", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": { threshold: 20, futureOption: "x" },
				},
			}),
		);
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.rules["high-complexity"]).toEqual({ threshold: 20 });
	});

	it("exposes the raw parsed JSON for forward-compat consumers", () => {
		const raw = {
			ignore: ["x/**"],
			rules: {},
			servers: { foo: { name: "foo" } },
			unknownFutureField: [1, 2, 3],
		};
		fs.writeFileSync(path.join(tmpDir, ".pi-lens.json"), JSON.stringify(raw));
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.raw).toEqual(raw);
	});

	it("findPiLensProjectConfig returns path, dir, and mtime for cache keys", () => {
		const configPath = path.join(tmpDir, ".pi-lens.json");
		fs.writeFileSync(configPath, JSON.stringify({ ignore: ["x/**"] }));
		const info = findPiLensProjectConfig(path.join(tmpDir, "src"));
		expect(info?.path).toBe(configPath);
		expect(info?.dir).toBe(tmpDir);
		expect(typeof info?.mtimeMs).toBe("number");
	});

	it("stops walking at the filesystem root without infinite-looping", () => {
		// /tmp/... is unlikely to have a .pi-lens.json anywhere up the tree
		// (the test runner's tmp dir is sandboxed). If the walker bug-loops,
		// vitest's test timeout will catch it.
		const cfg = loadPiLensProjectConfig(tmpDir);
		expect(cfg.configPath).toBeUndefined();
	});

	describe("reviewGraph.maxFiles (#775 R2)", () => {
		it("is undefined when the field is absent", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: [] }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toBeUndefined();
		});

		it("parses a valid in-range value", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 8000 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 8000 });
		});

		it("tolerantly parses a numeric string, like maxProjectFiles", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: "8000" } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 8000 });
		});

		it("floors a fractional value", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 8000.7 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 8000 });
		});

		it("clamps a value below the minimum (100) without warning", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 5 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 100 });
			expect(console.error).not.toHaveBeenCalled();
		});

		it("clamps a value above the maximum (20,000) without warning", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: 1_000_000 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toEqual({ maxFiles: 20_000 });
			expect(console.error).not.toHaveBeenCalled();
		});

		it("warns once and drops a non-numeric maxFiles", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: "not-a-number" } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph?.maxFiles).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"reviewGraph.maxFiles must be a positive finite number",
				),
			);
		});

		it("warns once and drops a non-positive maxFiles", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: -5 } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph?.maxFiles).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"reviewGraph.maxFiles must be a positive finite number",
				),
			);
		});

		it("warns once when reviewGraph itself is not an object", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: "not-an-object" }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.reviewGraph).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("reviewGraph must be an object"),
			);
		});

		it("only warns once for repeated loads of the same invalid config", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ reviewGraph: { maxFiles: "bogus" } }),
			);
			// Two loads without resetting the cache in between — the warn-once
			// dedupe (keyed by configPath:reason) must suppress the second call.
			loadPiLensProjectConfig(tmpDir);
			loadPiLensProjectConfig(tmpDir);
			const calls = (
				console.error as unknown as { mock: { calls: unknown[][] } }
			).mock.calls.filter((args) =>
				String(args[0]).includes("reviewGraph.maxFiles"),
			);
			expect(calls.length).toBe(1);
		});
	});

	// #533/#883: a shared `.pi-lens.json` typo must produce a signal, but the
	// file is ALSO the LSP loader's home, so foreign namespaces must stay
	// silent, and a user-level-only lens key gets a distinct scope signal.
	describe("unknown-key warnings (#533)", () => {
		function warnedFor(substring: string): boolean {
			return (console.error as ReturnType<typeof vi.fn>).mock.calls
				.flat()
				.some((arg) => typeof arg === "string" && arg.includes(substring));
		}

		it("warns on a typo'd top-level key", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ maxProjectFile: 5000, lps: { enabled: false } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('unknown key "maxProjectFile"'),
			);
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('unknown key "lps"'),
			);
		});

		it("does NOT warn on foreign LSP namespaces or $schema", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					$schema: "https://example.com/pi-lens.json",
					servers: { foo: { name: "foo" } },
					serverOverrides: { rust: {} },
					disabledServers: ["go"],
					warmFiles: ["src/main.ts"],
					// Legitimate project keys alongside them.
					ignore: ["dist/**"],
					format: { enabled: false },
				}),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).not.toHaveBeenCalled();
		});

		it("does NOT warn on the pi-lens-native `trivy` key (read via .raw)", () => {
			// `trivy.enabled`/`trivy.minSeverity` are read off PiLensProjectConfig.raw
			// by trivy-client.ts — a legitimate opt-in, must not look like a typo.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ trivy: { enabled: true, minSeverity: "HIGH" } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).not.toHaveBeenCalled();
		});

		it("signals that a global-only lens key is not honored at project scope", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ lsp: { enabled: false }, tests: { enabled: false } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(warnedFor("not honored in a project")).toBe(true);
			expect(warnedFor('"lsp"')).toBe(true);
			expect(warnedFor('"tests"')).toBe(true);
			// It is NOT reported as a typo — it is a real key, wrong scope.
			expect(warnedFor('unknown key "lsp"')).toBe(false);
		});

		it("warns once for the same typo across re-parses (warn-once dedup)", async () => {
			const p = path.join(tmpDir, ".pi-lens.json");
			fs.writeFileSync(p, JSON.stringify({ maxProjectFile: 5000 }));
			loadPiLensProjectConfig(tmpDir);
			// Force a re-parse (new mtime) WITHOUT clearing the warn-once cache.
			await new Promise((r) => setTimeout(r, 20));
			fs.writeFileSync(p, JSON.stringify({ maxProjectFile: 5000, ignore: [] }));
			loadPiLensProjectConfig(tmpDir);
			const typoWarns = (console.error as ReturnType<typeof vi.fn>).mock.calls
				.flat()
				.filter(
					(arg) =>
						typeof arg === "string" &&
						arg.includes('unknown key "maxProjectFile"'),
				);
			expect(typoWarns.length).toBe(1);
		});
	});

	// `rules.<id>.disable` / `rules.<id>.select` are the project-level rule
	// policy — output-only filtering applied by the dispatcher and the
	// `lens_diagnostics` tool. Disable wins over select (explicit exclusion
	// trumps explicit inclusion). The matcher normalizes rule ids so an entry
	// listed as `no-eval` covers `ast-grep:no-eval` and `no-eval-js` (the same
	// normalization the inline suppression parser already uses).
	describe("rules.<id>.disable / rules.<id>.select", () => {
		it("parses a disable list alongside a threshold", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": {
							threshold: 25,
							disable: ["no-eval", "no-debugger"],
						},
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]).toEqual({
				threshold: 25,
				disable: ["no-eval", "no-debugger"],
			});
		});

		it("parses a select list without any threshold", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": { select: ["no-eval", "no-debugger"] },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]).toEqual({
				select: ["no-eval", "no-debugger"],
			});
		});

		it("accepts a policy-only entry (no threshold, only disable/select)", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"unused-var": { disable: ["no-unused-vars"] },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["unused-var"]).toEqual({
				disable: ["no-unused-vars"],
			});
		});

		it("filters non-string entries out of disable/select lists", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": {
							disable: ["no-eval", 42, null, "no-debugger", { x: 1 }],
						},
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toEqual([
				"no-eval",
				"no-debugger",
			]);
		});

		it("trims whitespace around list entries", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": { disable: ["  no-eval  ", " no-debugger"] },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toEqual([
				"no-eval",
				"no-debugger",
			]);
		});

		it("warns when the lists are written directly under rules (#444's own example)", () => {
			// `{"rules": {"disable": [...]}}` is the shape the issue proposed and
			// the most likely thing a user tries. It parses as valid JSON and has
			// zero effect, so it has to say so rather than fail silent.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ rules: { disable: ["no-eval"] } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules.disable).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.disable must be an object with threshold, disable, or select",
				),
			);
		});

		it("warns on a rule entry whose only key is unrecognized (e.g. #444's `only`)", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ rules: { "no-eval": { only: ["no-eval"] } } }),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["no-eval"]).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.no-eval has no recognized setting (threshold, disable, select)",
				),
			);
		});

		it("does not warn twice when a recognized field was merely malformed", () => {
			// `disable` already warned about its own shape — adding a second
			// "no recognized setting" line for the same entry would be noise.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ rules: { "no-eval": { disable: "no-eval" } } }),
			);
			loadPiLensProjectConfig(tmpDir);
			expect(console.error).not.toHaveBeenCalledWith(
				expect.stringContaining("has no recognized setting"),
			);
		});

		it("warns once and drops a non-array disable", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { disable: "no-eval" } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.high-complexity.disable must be an array of strings",
				),
			);
		});

		it("warns once and drops a non-array select", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { select: { id: "no-eval" } } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.select).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.high-complexity.select must be an array of strings",
				),
			);
		});

		it("treats an explicitly empty disable list as a silent no-op (#1087)", () => {
			// #1087 P3-7: `"disable": []` is well-formed — an intentional empty
			// list — not an error. It must NOT warn (the old code did), and the
			// pointless entry is dropped rather than stored.
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { disable: [] } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]).toBeUndefined();
			expect(console.error).not.toHaveBeenCalled();
		});

		it("warns once and drops a non-empty select list with no usable strings", () => {
			// A NON-empty array whose entries are all blank/non-string is a real
			// authoring mistake and must still warn (distinct from `[]` above).
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { select: [42, null, true] } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.select).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"rules.high-complexity.select must contain at least one non-empty string",
				),
			);
		});

		it("preserves threshold when an invalid disable value is dropped", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-complexity": { threshold: 25, disable: "bad" } },
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.threshold).toBe(25);
			expect(cfg.rules["high-complexity"]?.disable).toBeUndefined();
		});

		it("preserves both disable and select when both are valid", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"high-complexity": {
							disable: ["no-eval"],
							select: ["no-debugger"],
						},
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			expect(cfg.rules["high-complexity"]?.disable).toEqual(["no-eval"]);
			expect(cfg.rules["high-complexity"]?.select).toEqual(["no-debugger"]);
		});

		it("does not warn on a forward-compat entry with no recognized fields", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"future-rule": { unrelated: true },
					},
				}),
			);
			const cfg = loadPiLensProjectConfig(tmpDir);
			// No recognized fields → entry not stored (forward-compat). No
			// warning emitted either, since unrecognized keys are silently
			// ignored for forward-compat rules per the existing describe block.
			expect(cfg.rules["future-rule"]).toBeUndefined();
		});
	});
});

describe("config cache freshness (#1105 mtime+size)", () => {
	// The config cache gates reuse on mtime alone before #1105; an in-place edit
	// that PRESERVES mtime (git checkout timestamp restoration, a same-second
	// rewrite) but changes the file's byte length replayed a stale parsed config.
	// The fix adds `size` as the free second axis (the stat that yields mtime
	// already read it). Both writes below are pinned to the SAME fixed mtime, so
	// mtime is identical across the two loads and ONLY size differs — isolating
	// exactly the residual the second axis closes. FS-agnostic (no case/separator
	// assumptions), so it exercises the gate identically on Linux CI (#1024).
	it("re-parses an mtime-preserving, length-changing config edit", () => {
		const configPath = path.join(tmpDir, ".pi-lens.json");
		const pinned = new Date("2020-01-01T00:00:00.000Z");

		// First config — a longer ignore list (larger byte length).
		fs.writeFileSync(
			configPath,
			JSON.stringify({ ignore: ["alpha/**", "beta/**", "gamma/**"] }),
		);
		fs.utimesSync(configPath, pinned, pinned);
		const mtimeBefore = fs.statSync(configPath).mtimeMs;
		const first = loadPiLensProjectConfig(tmpDir);
		expect(first.ignore).toEqual(["alpha/**", "beta/**", "gamma/**"]);

		// Rewrite in place with a SHORTER config, then restore the SAME mtime so
		// the mtime-only gate would (wrongly) treat the cached entry as fresh.
		fs.writeFileSync(configPath, JSON.stringify({ ignore: ["alpha/**"] }));
		fs.utimesSync(configPath, pinned, pinned);
		// The gate is now isolated to the size axis: mtime is provably identical.
		expect(fs.statSync(configPath).mtimeMs).toBe(mtimeBefore);

		// Cache is intentionally NOT reset — this asserts the in-process gate, not
		// a cold read. Pre-#1105 (mtime-only) this returned the stale 3-entry list.
		const second = loadPiLensProjectConfig(tmpDir);
		expect(second.ignore).toEqual(["alpha/**"]);
	});
});
