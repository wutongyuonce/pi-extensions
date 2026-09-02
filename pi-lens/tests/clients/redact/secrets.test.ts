import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../clients/redact/secrets.js";

const JWT = [
	"ey",
	"JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value",
].join("");
const JWE = ["ey", "JhbGciOiJIUzI1NiJ9..aXY.Y2lwaGVydGV4dA.dGFn"].join("");
const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const AWS_KEY = `AKIA${"A".repeat(16)}`;

function privateKeyBegin(label: string): string {
	return `-----BEGIN ${label}-----`;
}

function privateKeyEnd(label: string): string {
	return `-----END ${label}-----`;
}

function privateKeyBlock(label: string): string {
	return [privateKeyBegin(label), "secret", privateKeyEnd(label)].join("\n");
}

const cases = [
	{
		name: "GitHub token",
		secret: GITHUB_TOKEN,
		replacement: "[REDACTED:github-token]",
	},
	{
		name: "GitHub fine-grained token",
		secret: `github_pat_${"a".repeat(22)}_${"b".repeat(40)}`,
		replacement: "[REDACTED:github-token]",
	},
	{
		name: "AWS access key",
		secret: AWS_KEY,
		replacement: "[REDACTED:aws-access-key]",
	},
	{
		name: "AWS temporary access key",
		secret: `ASIA${"B".repeat(16)}`,
		replacement: "[REDACTED:aws-access-key]",
	},
	{
		name: "Slack token",
		secret: ["xox", "b-123456789012-123456789012-abcdefghijklmnop"].join(""),
		replacement: "[REDACTED:slack-token]",
	},
	{
		name: "Stripe secret key",
		secret: `sk_live_${"c".repeat(24)}`,
		replacement: "[REDACTED:stripe-key]",
	},
	{
		name: "Stripe restricted key",
		secret: `rk_test_${"d".repeat(24)}`,
		replacement: "[REDACTED:stripe-key]",
	},
	{
		name: "GitLab token",
		secret: `glpat-${"e".repeat(24)}`,
		replacement: "[REDACTED:gitlab-token]",
	},
	{
		name: "Google API key",
		secret: `AIza${"f".repeat(35)}`,
		replacement: "[REDACTED:google-api-key]",
	},
	{
		name: "Google OAuth secret",
		secret: `GOCSPX-${"g".repeat(28)}`,
		replacement: "[REDACTED:google-oauth-secret]",
	},
	{
		name: "SendGrid key",
		secret: `SG.${"h".repeat(22)}.${"i".repeat(43)}`,
		replacement: "[REDACTED:sendgrid-key]",
	},
	{
		name: "OpenAI project key",
		secret: `sk-proj-${"j".repeat(48)}`,
		replacement: "[REDACTED:openai-key]",
	},
	{
		name: "OpenAI service-account key",
		secret: `sk-svcacct-${"k".repeat(48)}`,
		replacement: "[REDACTED:openai-key]",
	},
	{
		name: "OpenAI legacy base62 key",
		secret: `sk-${"A1b2".repeat(12)}`,
		replacement: "[REDACTED:openai-key]",
	},
	{
		name: "JWT",
		secret: JWT,
		replacement: "[REDACTED:jwt]",
	},
	{
		name: "five-part JWE",
		secret: JWE,
		replacement: "[REDACTED:jwt]",
	},
];

describe("redactSecrets", () => {
	it.each(cases)("redacts a $name", (testCase) => {
		expect(redactSecrets(`before ${testCase.secret} after`)).toBe(
			`before ${testCase.replacement} after`,
		);
	});

	it("recognizes token prefixes inside hostile surrounding text", () => {
		expect(redactSecrets(`x${GITHUB_TOKEN}`)).toBe("x[REDACTED:github-token]");
		expect(redactSecrets(`_${AWS_KEY}`)).toBe("_[REDACTED:aws-access-key]");
		expect(redactSecrets(`a${JWT}`)).toBe("a[REDACTED:jwt]");
		const malformedSendGrid = `SG.zz${AWS_KEY}.${"x".repeat(44)}`;
		expect(redactSecrets(malformedSendGrid)).toBe(
			`SG.zz[REDACTED:aws-access-key].${"x".repeat(44)}`,
		);
		const failedJwtPrefix = ["ey", "Jaaaaa."].join("");
		expect(redactSecrets(`${failedJwtPrefix}${GITHUB_TOKEN}`)).toBe(
			`${failedJwtPrefix}[REDACTED:github-token]`,
		);
		const nestedJwt = ["ey", `Jaaaaa.key..${JWT}`].join("");
		expect(redactSecrets(nestedJwt)).toBe(
			`${["ey", "Jaaaaa.key.."].join("")}[REDACTED:jwt]`,
		);
	});

	it("redacts real OpenAI keys but never kebab-case identifiers", () => {
		// Hits: modern prefixes and a strict legacy base62 key (>=40 alnum, has a digit).
		expect(redactSecrets(`sk-proj-${"a".repeat(24)}`)).toBe(
			"[REDACTED:openai-key]",
		);
		expect(redactSecrets(`sk-svcacct-${"b".repeat(24)}`)).toBe(
			"[REDACTED:openai-key]",
		);
		const legacyKey = `sk-${"c3D4".repeat(12)}`;
		expect(redactSecrets(legacyKey)).toBe("[REDACTED:openai-key]");
		expect(redactSecrets(`token=${legacyKey} done`)).toBe(
			"token=[REDACTED:openai-key] done",
		);

		// Misses: kebab-case slugs (a '-' ends the base62 suffix well short of 40).
		for (const slug of [
			"sk-skeleton-loading-placeholder",
			"sk-button-large",
			"sk-proj-short",
		]) {
			expect(redactSecrets(slug)).toBe(slug);
		}
		// Miss: >=40 chars but no digit — legacy keys always carry digits.
		const noDigit = `sk-${"z".repeat(48)}`;
		expect(redactSecrets(noDigit)).toBe(noDigit);
		// Miss: has a digit but only 39 alnum chars — below the length bar.
		const tooShort = `sk-${"y".repeat(38)}7`;
		expect(redactSecrets(tooShort)).toBe(tooShort);
	});

	it("redacts complete and unterminated PEM private keys", () => {
		const pem = [
			privateKeyBegin("RSA PRIVATE KEY"),
			"c2VjcmV0LWtleS1tYXRlcmlhbA==",
			privateKeyEnd("RSA PRIVATE KEY"),
		].join("\n");

		expect(redactSecrets(`before ${pem} after`)).toBe(
			"before [REDACTED:private-key] after",
		);
		expect(
			redactSecrets(
				`before ${privateKeyBegin("OPENSSH PRIVATE KEY")}\nprivate material`,
			),
		).toBe("before [REDACTED:private-key]");
	});

	it("redacts PEM blocks inside JSON-escaped text without corrupting JSON", () => {
		const serialized = JSON.stringify({
			message: `before ${privateKeyBegin("PRIVATE KEY")}\nsecret\n${privateKeyEnd("PRIVATE KEY")} after`,
		});
		const parsed = JSON.parse(redactSecrets(serialized)) as { message: string };

		expect(parsed.message).toBe("before [REDACTED:private-key] after");

		const unterminated = JSON.stringify({
			message: `before ${privateKeyBegin("PRIVATE KEY")}\nsecret`,
			after: true,
		});
		const unterminatedParsed = JSON.parse(redactSecrets(unterminated)) as {
			message: string;
			after: boolean;
		};
		expect(unterminatedParsed).toEqual({
			message: "before [REDACTED:private-key]",
			after: true,
		});
	});

	it("requires a valid JWT shape and preserves trailing dot segments", () => {
		const invalidJwt = ["ey", "Jaaaaa.."].join("");
		expect(redactSecrets(invalidJwt)).toBe(invalidJwt);
		expect(redactSecrets(`${JWT}.word`)).toBe("[REDACTED:jwt].word");
	});

	it("leaves benign text and public certificates untouched", () => {
		const benign = [
			"ghp_short",
			"AKIA_TOO_SHORT",
			["ey", "Jnot-a-jwt"].join(""),
			"sk-test-value",
			"-----BEGIN CERTIFICATE-----",
			"public material",
			"-----END CERTIFICATE-----",
		].join("\n");

		expect(redactSecrets(benign)).toBe(benign);
	});

	it("ends a token at the ASCII alphanumeric range edges", () => {
		for (const char of ["/", ":", "@", "[", "`", "{"]) {
			expect(redactSecrets(`${GITHUB_TOKEN}${char}tail`)).toBe(
				`[REDACTED:github-token]${char}tail`,
			);
		}
		expect(redactSecrets(`ghp_${"a".repeat(33)}0Zz`)).toBe(
			"[REDACTED:github-token]",
		);
	});

	it("treats non-ASCII characters as token terminators", () => {
		expect(redactSecrets(`${GITHUB_TOKEN}😀tail`)).toBe(
			"[REDACTED:github-token]😀tail",
		);
		expect(redactSecrets(`${GITHUB_TOKEN}é`)).toBe("[REDACTED:github-token]é");
		const tooShort = `ghp_${"a".repeat(19)}😀`;
		expect(redactSecrets(tooShort)).toBe(tooShort);
	});

	it("requires uppercase alphanumerics for AWS access keys", () => {
		expect(redactSecrets(`${AWS_KEY}bcd`)).toBe("[REDACTED:aws-access-key]bcd");
		expect(redactSecrets(`ASIA${"9".repeat(16)}😀`)).toBe(
			"[REDACTED:aws-access-key]😀",
		);
		const tooShort = `AKIA${"A".repeat(15)}z`;
		expect(redactSecrets(tooShort)).toBe(tooShort);
	});

	it("accepts only uppercase, digit and space characters in a PEM label", () => {
		expect(redactSecrets(privateKeyBlock("RSA PRIVATE KEY 2"))).toBe(
			"[REDACTED:private-key]",
		);

		for (const label of ["PRIVATE KEYÉ", "PRIVATE KEY😀", "Rsa PRIVATE KEY"]) {
			const rejected = `${privateKeyBegin(label)}\nsecret\n`;
			expect(redactSecrets(rejected)).toBe(rejected);
		}
	});

	it("keeps scanning for secrets after each replacement", () => {
		expect(redactSecrets(`${GITHUB_TOKEN},${AWS_KEY},${JWT}`)).toBe(
			"[REDACTED:github-token],[REDACTED:aws-access-key],[REDACTED:jwt]",
		);
		expect(redactSecrets(`ghp_short ${GITHUB_TOKEN}`)).toBe(
			"ghp_short [REDACTED:github-token]",
		);
		expect(redactSecrets(GITHUB_TOKEN)).toBe("[REDACTED:github-token]");
	});

	it("walks past non-private PEM blocks to reach later private keys", () => {
		const cert = [
			"-----BEGIN CERTIFICATE-----",
			"public material",
			"-----END CERTIFICATE-----",
		].join("\n");
		const key = privateKeyBlock("PRIVATE KEY");

		expect(redactSecrets(`${cert}\n${key}\ntail`)).toBe(
			`${cert}\n[REDACTED:private-key]\ntail`,
		);
		expect(redactSecrets(`${key}\n${cert}\n${key}`)).toBe(
			`[REDACTED:private-key]\n${cert}\n[REDACTED:private-key]`,
		);
	});

	it("stops at an orphaned or mismatched PEM header", () => {
		const orphanBegin = "before -----BEGIN ";
		expect(redactSecrets(orphanBegin)).toBe(orphanBegin);

		const mismatchedEnd = [
			privateKeyBegin("PRIVATE KEY"),
			"secret",
			privateKeyEnd("OTHER KEY"),
		].join("\n");
		expect(redactSecrets(mismatchedEnd)).toBe("[REDACTED:private-key]");
	});

	it("handles large prefix-heavy non-matches without catastrophic backtracking", () => {
		const input = ["ey", "J-"].join("").repeat(32_000);
		const startedAt = performance.now();

		expect(redactSecrets(input)).toBe(input);
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});
});
