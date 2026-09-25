import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	getProjectTrustGeneration,
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	buildProcessSpec,
	MAX_ARGV_ENTRIES,
	MAX_ENV_BYTES,
	MAX_ENV_ENTRIES,
	MAX_TIMEOUT_MS,
	type ProcessSpec,
	redactProcessSpec,
	toSpawnArgs,
} from "../../../clients/config-core/process-spec.js";
import {
	SOURCE_TIERS,
	type SourceTier,
	type TrustDecision,
} from "../../../clients/config-core/provenance.js";

const SECRET_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

function specFor(
	tier: SourceTier,
	trust: TrustDecision,
	overrides: Partial<Parameters<typeof buildProcessSpec>[0]> = {},
): ProcessSpec {
	const built = buildProcessSpec({
		argv: ["pyright-langserver", "--stdio", `--header=${SECRET_TOKEN}`],
		env: { PYRIGHT_TOKEN: SECRET_TOKEN, PATH: "/usr/bin" },
		cwdMode: "root",
		inputMode: "stdin",
		timeoutMs: 5000,
		provenance: { tier, key: "/lsp/servers/0", file: ".pi-lens.json" },
		trust,
		...overrides,
	});
	if (!built.ok) throw new Error(`fixture rejected: ${built.rejection.code}`);
	return built.spec;
}

beforeEach(() => {
	resetDegradationLedger();
	resetProjectTrust();
});

afterEach(() => {
	resetProjectTrust();
	resetDegradationLedger();
});

describe("buildProcessSpec validates before anything can hold a spec (#2425)", () => {
	it("builds a well-formed spec", () => {
		const built = buildProcessSpec({
			argv: ["gopls"],
			timeoutMs: 1000,
			provenance: { tier: "global", key: "/lsp" },
			trust: "unknown",
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.spec.argv).toEqual(["gopls"]);
		expect(built.spec.env).toEqual({});
		expect(built.spec.cwdMode).toBe("root");
		expect(built.spec.inputMode).toBe("none");
	});

	const REJECTIONS: ReadonlyArray<{
		readonly name: string;
		readonly code: string;
		readonly input: Parameters<typeof buildProcessSpec>[0];
	}> = [
		{
			name: "an empty argv",
			code: "empty-argv",
			input: {
				argv: [],
				timeoutMs: 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "an empty command",
			code: "empty-argv",
			input: {
				argv: [""],
				timeoutMs: 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "a non-string argv entry",
			code: "argv-not-strings",
			input: {
				argv: ["gopls", 7],
				timeoutMs: 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "too many argv entries",
			code: "argv-too-many",
			input: {
				argv: Array.from({ length: MAX_ARGV_ENTRIES + 1 }, () => "x"),
				timeoutMs: 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "too many env entries",
			code: "env-too-many",
			input: {
				argv: ["gopls"],
				env: Object.fromEntries(
					Array.from({ length: MAX_ENV_ENTRIES + 1 }, (_, index) => [
						`K${index}`,
						"v",
					]),
				),
				timeoutMs: 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "an oversized env",
			code: "env-too-large",
			input: {
				argv: ["gopls"],
				env: { BIG: "v".repeat(MAX_ENV_BYTES + 1) },
				timeoutMs: 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "a non-string env value",
			code: "env-not-strings",
			input: {
				argv: ["gopls"],
				env: { N: 1 },
				timeoutMs: 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "a zero timeout",
			code: "invalid-timeout",
			input: {
				argv: ["gopls"],
				timeoutMs: 0,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "a timeout past the ceiling",
			code: "invalid-timeout",
			input: {
				argv: ["gopls"],
				timeoutMs: MAX_TIMEOUT_MS + 1,
				provenance: { tier: "global", key: "/x" },
			},
		},
		{
			name: "a NaN timeout",
			code: "invalid-timeout",
			input: {
				argv: ["gopls"],
				timeoutMs: Number.NaN,
				provenance: { tier: "global", key: "/x" },
			},
		},
	];

	it("covers every rejection the table claims to", () => {
		// Declared floor: an emptied table must FAIL, not read as clean.
		expect(REJECTIONS.length).toBeGreaterThanOrEqual(10);
	});

	for (const rejection of REJECTIONS) {
		it(`refuses ${rejection.name}`, () => {
			const built = buildProcessSpec(rejection.input);
			expect(built.ok).toBe(false);
			if (built.ok) return;
			expect(built.rejection.code).toBe(rejection.code);
			expect(built.rejection.reason).not.toContain(SECRET_TOKEN);
		});
	}

	it("adopts the host trust decision when the caller states none", () => {
		setProjectTrustState("untrusted");
		const built = buildProcessSpec({
			argv: ["gopls"],
			timeoutMs: 1000,
			provenance: { tier: "project", key: "/lsp" },
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.spec.trust).toBe("untrusted");
	});
});

/**
 * #2415 AC 3, the trust half: the full tier x trust cross product, with the
 * host's live decision held at each of its three values. Nothing here spawns —
 * the point of a pure gate is that the whole matrix is cheap.
 */
describe("toSpawnArgs trust matrix (#2425)", () => {
	const TRUST_VALUES: readonly TrustDecision[] = [
		"trusted",
		"untrusted",
		"unknown",
	];

	it("covers every tier in the vocabulary", () => {
		expect(SOURCE_TIERS.length).toBe(7);
	});

	for (const tier of SOURCE_TIERS) {
		for (const specTrust of TRUST_VALUES) {
			for (const hostTrust of TRUST_VALUES) {
				const repoTier = tier === "project" || tier === "nested-project";
				const allowed =
					!repoTier || (specTrust === "trusted" && hostTrust === "trusted");
				it(`${allowed ? "allows" : "refuses"} ${tier} with spec ${specTrust} and host ${hostTrust}`, () => {
					setProjectTrustState(hostTrust);
					const result = toSpawnArgs(specFor(tier, specTrust));
					expect(result.ok).toBe(allowed);
					if (result.ok) {
						expect(result.args.argv[0]).toBe("pyright-langserver");
						return;
					}
					expect(result.refusal.kind).toBe("trust-refusal");
					expect(result.refusal.tier).toBe(tier);
					expect(result.refusal.cause).toBe(
						specTrust === "trusted" ? "host-trust" : "spec-trust",
					);
				});
			}
		}
	}

	it("refuses a spec whose recorded trust is stale even when the host now trusts", () => {
		// The capability-token defect: a spec built while the project was trusted
		// must not keep spawning after a revoke, and a spec that recorded
		// `untrusted` must not start spawning just because the host changed later.
		setProjectTrustState("trusted");
		expect(toSpawnArgs(specFor("project", "untrusted")).ok).toBe(false);
		setProjectTrustState("untrusted");
		expect(toSpawnArgs(specFor("project", "trusted")).ok).toBe(false);
	});
});

describe("a refusal is recorded once, through the existing ledger kind (#2425)", () => {
	it("writes a trust-refusal row naming the tier and the command", () => {
		setProjectTrustState("untrusted");
		const spec = specFor("project", "untrusted");
		expect(toSpawnArgs(spec).ok).toBe(false);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "trust-refusal",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0].subject).toBe(
			`config-command:g${getProjectTrustGeneration()}:project:pyright-langserver`,
		);
	});

	it("counts repeats exactly while keeping ONE retained entry per subject", () => {
		setProjectTrustState("untrusted");
		const spec = specFor("project", "untrusted");
		for (let attempt = 0; attempt < 5; attempt += 1) toSpawnArgs(spec);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "trust-refusal",
		);
		expect(group?.count).toBe(5);
		expect(group?.latestReasons).toHaveLength(1);
	});

	it("carries the trust generation the refusal happened in", () => {
		setProjectTrustState("untrusted");
		const before = getProjectTrustGeneration();
		const first = toSpawnArgs(specFor("project", "untrusted"));
		expect(first.ok).toBe(false);
		if (first.ok) return;
		expect(first.refusal.trustGeneration).toBe(before);

		setProjectTrustState("trusted");
		setProjectTrustState("untrusted");
		const later = toSpawnArgs(specFor("project", "untrusted"));
		expect(later.ok).toBe(false);
		if (later.ok) return;
		expect(later.refusal.trustGeneration).toBeGreaterThan(before);
	});

	it("re-arms the count and the durable row for each trust EPISODE", () => {
		// #2440 review F6. `incrementDegradationCount` tallies on `kind\0subject`
		// and writes a durable row on the first occurrence and at power-of-two
		// milestones. A generation-free subject made one unbroken series across
		// every revoke/re-grant cycle, so the second episode's first refusal was
		// count 4 — not a power of two, hence NO durable row for that episode at
		// all, and a count that described neither.
		setProjectTrustState("untrusted");
		const firstGeneration = getProjectTrustGeneration();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			toSpawnArgs(specFor("project", "untrusted"));
		}
		const firstSubject = `config-command:g${firstGeneration}:project:pyright-langserver`;
		const afterFirst = getDegradationSummary().find(
			(entry) => entry.kind === "trust-refusal",
		);
		expect(
			afterFirst?.latestReasons.find(
				(reason) => reason.subject === firstSubject,
			)?.reason,
		).toContain("(count: 3)");

		// A revoke -> re-grant -> revoke cycle bumps the generation.
		setProjectTrustState("trusted");
		setProjectTrustState("untrusted");
		const secondGeneration = getProjectTrustGeneration();
		expect(secondGeneration).toBeGreaterThan(firstGeneration);

		const refusal = toSpawnArgs(specFor("project", "untrusted"));
		expect(refusal.ok).toBe(false);
		const secondSubject = `config-command:g${secondGeneration}:project:pyright-langserver`;
		const afterSecond = getDegradationSummary().find(
			(entry) => entry.kind === "trust-refusal",
		);
		// The new episode starts its own series at 1 — which IS a power of two,
		// so it also produces a durable row.
		expect(
			afterSecond?.latestReasons.find(
				(reason) => reason.subject === secondSubject,
			)?.reason,
		).toContain("(count: 1)");
		// The previous episode's series survives beside it rather than being
		// continued by it.
		expect(
			afterSecond?.latestReasons.some(
				(reason) => reason.subject === firstSubject,
			),
		).toBe(true);
	});

	it("records nothing when an operator-tier spec passes", () => {
		setProjectTrustState("untrusted");
		expect(toSpawnArgs(specFor("global", "untrusted")).ok).toBe(true);
		expect(
			getDegradationSummary().some((entry) => entry.kind === "trust-refusal"),
		).toBe(false);
	});

	it("keeps every argument and env value out of the refusal and the ledger", () => {
		setProjectTrustState("untrusted");
		const result = toSpawnArgs(specFor("project", "untrusted"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(JSON.stringify(result.refusal)).not.toContain(SECRET_TOKEN);
		expect(JSON.stringify(getDegradationSummary())).not.toContain(SECRET_TOKEN);
	});
});

describe("redactProcessSpec strips env values and the argv tail (#2415 AC 4)", () => {
	it("keeps the command and the env NAMES, and nothing else", () => {
		const projection = redactProcessSpec(specFor("project", "trusted"));
		expect(projection).toEqual({
			command: "pyright-langserver",
			argvCount: 3,
			envNames: ["PATH", "PYRIGHT_TOKEN"],
			envCount: 2,
			cwdMode: "root",
			inputMode: "stdin",
			timeoutMs: 5000,
			tier: "project",
			configKey: "/lsp/servers/0",
			file: ".pi-lens.json",
			trust: "trusted",
		});
	});

	it("lets no env value and no argv tail survive the projection", () => {
		const serialized = JSON.stringify(
			redactProcessSpec(specFor("project", "trusted")),
		);
		expect(serialized).not.toContain(SECRET_TOKEN);
		expect(serialized).not.toContain("--header");
		expect(serialized).not.toContain("--stdio");
		expect(serialized).not.toContain("/usr/bin");
	});

	it("carries no absolute home path in the projected file (#2440 F5)", () => {
		const home = os.homedir();
		const spec = specFor("global", "trusted", {
			provenance: {
				tier: "global",
				key: "/lsp/servers/0",
				file: path.join(home, ".pi-lens", "config.json"),
			},
		});
		const projection = redactProcessSpec(spec);
		expect(projection.file).toBe("~/.pi-lens/config.json");
		expect(JSON.stringify(projection)).not.toContain(home);
	});

	it("orders env names locale-independently (#2440 F4)", () => {
		// Sonar S2871 wants a comparator; `localeCompare` would have been the
		// obvious one and the wrong one, because its answer depends on the
		// machine's locale and ICU build. The pinned order is code-unit order,
		// where every uppercase letter precedes every lowercase one.
		const spec = specFor("global", "trusted", {
			env: { b: "1", A: "2", a: "3", B: "4", _: "5" },
		});
		expect(redactProcessSpec(spec).envNames).toEqual(["A", "B", "_", "a", "b"]);
	});
});
