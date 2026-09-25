const PEM_BEGIN = "-----BEGIN ";
const PEM_DELIMITER = "-----";

interface SecretScan {
	start?: number;
	end: number;
	replacement?: string;
}

interface JwtSegment {
	candidate: number;
	length: number;
	end: number;
}

interface SecretRange {
	start: number;
	end: number;
}

interface JwtSegmentOptions {
	text: string;
	start: number;
	end: number;
}

interface ScanPosition {
	text: string;
	start: number;
}

type CharPredicate = (char: string | undefined) => boolean;
type SecretScanner = (position: ScanPosition) => SecretScan | undefined;

interface RedactScannerOptions {
	text: string;
	scanner: SecretScanner;
}

interface PrefixedSecret {
	prefix: string;
	minSuffixLength: number;
	predicate: CharPredicate;
	replacement: string;
}

function codePointOf(char: string | undefined): number {
	return char?.codePointAt(0) ?? -1;
}

function isAsciiAlphaNumeric(char: string | undefined): boolean {
	const code = codePointOf(char);
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122)
	);
}

function isUpperAlphaNumeric(char: string | undefined): boolean {
	const code = codePointOf(char);
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
}

function isIdentifierChar(char: string | undefined): boolean {
	return char === "_" || isAsciiAlphaNumeric(char);
}

function isTokenChar(char: string | undefined): boolean {
	return char === "-" || isIdentifierChar(char);
}

const PREFIXED_SECRETS: readonly PrefixedSecret[] = [
	{
		prefix: "ghp_",
		minSuffixLength: 20,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:github-token]",
	},
	{
		prefix: "gho_",
		minSuffixLength: 20,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:github-token]",
	},
	{
		prefix: "ghu_",
		minSuffixLength: 20,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:github-token]",
	},
	{
		prefix: "ghs_",
		minSuffixLength: 20,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:github-token]",
	},
	{
		prefix: "ghr_",
		minSuffixLength: 20,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:github-token]",
	},
	{
		prefix: "github_pat_",
		minSuffixLength: 20,
		predicate: isTokenChar,
		replacement: "[REDACTED:github-token]",
	},
	{
		prefix: "AKIA",
		minSuffixLength: 16,
		predicate: isUpperAlphaNumeric,
		replacement: "[REDACTED:aws-access-key]",
	},
	{
		prefix: "ASIA",
		minSuffixLength: 16,
		predicate: isUpperAlphaNumeric,
		replacement: "[REDACTED:aws-access-key]",
	},
	{
		prefix: "sk_live_",
		minSuffixLength: 16,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:stripe-key]",
	},
	{
		prefix: "sk_test_",
		minSuffixLength: 16,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:stripe-key]",
	},
	{
		prefix: "rk_live_",
		minSuffixLength: 16,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:stripe-key]",
	},
	{
		prefix: "rk_test_",
		minSuffixLength: 16,
		predicate: isAsciiAlphaNumeric,
		replacement: "[REDACTED:stripe-key]",
	},
	{
		prefix: "glpat-",
		minSuffixLength: 20,
		predicate: isTokenChar,
		replacement: "[REDACTED:gitlab-token]",
	},
	{
		prefix: "AIza",
		minSuffixLength: 35,
		predicate: isTokenChar,
		replacement: "[REDACTED:google-api-key]",
	},
	{
		prefix: "GOCSPX-",
		minSuffixLength: 20,
		predicate: isTokenChar,
		replacement: "[REDACTED:google-oauth-secret]",
	},
	{
		prefix: "sk-proj-",
		minSuffixLength: 20,
		predicate: isTokenChar,
		replacement: "[REDACTED:openai-key]",
	},
	{
		prefix: "sk-svcacct-",
		minSuffixLength: 20,
		predicate: isTokenChar,
		replacement: "[REDACTED:openai-key]",
	},
];

/**
 * Minimum suffix length for a legacy `sk-<base62>` OpenAI key. Legacy keys are
 * 48 base62 chars; require a high bar so ordinary kebab-case identifiers
 * (`sk-skeleton-loading-placeholder`, `sk-button-large`) never match.
 */
const OPENAI_LEGACY_MIN_SUFFIX = 40;

interface ConsumeOptions extends ScanPosition {
	predicate: CharPredicate;
}

function consumeWhile(options: ConsumeOptions): number {
	let end = options.start;
	while (end < options.text.length && options.predicate(options.text[end])) {
		end++;
	}
	return end;
}

function scanPrefixedSecret(position: ScanPosition): SecretScan | undefined {
	for (const secret of PREFIXED_SECRETS) {
		if (
			position.text[position.start] !== secret.prefix[0] ||
			!position.text.startsWith(secret.prefix, position.start)
		) {
			continue;
		}
		const suffixStart = position.start + secret.prefix.length;
		const end = consumeWhile({
			text: position.text,
			start: suffixStart,
			predicate: secret.predicate,
		});
		return end - suffixStart >= secret.minSuffixLength
			? { end, replacement: secret.replacement }
			: { end: Math.max(end, suffixStart) };
	}
	return undefined;
}

function scanSlackToken(position: ScanPosition): SecretScan | undefined {
	const variant = position.text[position.start + 3];
	if (
		!position.text.startsWith("xox", position.start) ||
		variant === undefined ||
		variant < "a" ||
		variant > "z" ||
		position.text[position.start + 4] !== "-"
	) {
		return undefined;
	}
	const suffixStart = position.start + 5;
	const end = consumeWhile({
		text: position.text,
		start: suffixStart,
		predicate: isTokenChar,
	});
	return end - suffixStart >= 10
		? { end, replacement: "[REDACTED:slack-token]" }
		: { end: Math.max(end, suffixStart) };
}

function scanSendGridKey(position: ScanPosition): SecretScan | undefined {
	if (!position.text.startsWith("SG.", position.start)) return undefined;
	const retryAt = position.start + 1;
	const firstStart = position.start + 3;
	const firstEnd = firstStart + 22;
	for (let index = firstStart; index < firstEnd; index++) {
		if (!isTokenChar(position.text[index])) return { end: retryAt };
	}
	if (position.text[firstEnd] !== ".") return { end: retryAt };

	const secondStart = firstEnd + 1;
	const end = secondStart + 43;
	for (let index = secondStart; index < end; index++) {
		if (!isTokenChar(position.text[index])) return { end: retryAt };
	}
	return isTokenChar(position.text[end])
		? { end: retryAt }
		: { end, replacement: "[REDACTED:sendgrid-key]" };
}

function createJwtSegment(options: JwtSegmentOptions): JwtSegment {
	const possibleCandidate = options.text.indexOf("eyJ", options.start);
	const candidate =
		possibleCandidate !== -1 &&
		possibleCandidate < options.end &&
		options.end - (possibleCandidate + 3) >= 5
			? possibleCandidate
			: -1;
	return {
		candidate,
		length: options.end - options.start,
		end: options.end,
	};
}

function chooseSecretRange(options: {
	current?: SecretRange;
	candidate?: SecretRange;
}): SecretRange | undefined {
	if (!options.candidate) return options.current;
	if (!options.current) return options.candidate;
	return options.candidate.start < options.current.start ||
		(options.candidate.start === options.current.start &&
			options.candidate.end > options.current.end)
		? options.candidate
		: options.current;
}

function findNestedJwtRange(segments: JwtSegment[]): SecretRange | undefined {
	let result: SecretRange | undefined;
	const jweStart = segments.length - 5;
	if (
		jweStart >= 0 &&
		segments[jweStart].candidate !== -1 &&
		segments[jweStart + 2].length > 0 &&
		segments[jweStart + 3].length > 0 &&
		segments[jweStart + 4].length > 0
	) {
		result = {
			start: segments[jweStart].candidate,
			end: segments[jweStart + 4].end,
		};
	}

	const jwtStart = segments.length - 3;
	const isJwt =
		jwtStart >= 0 &&
		segments[jwtStart].candidate !== -1 &&
		segments[jwtStart + 1].length > 0 &&
		segments[jwtStart + 2].length > 0;
	return isJwt
		? chooseSecretRange({
				current: result,
				candidate: {
					start: segments[jwtStart].candidate,
					end: segments[jwtStart + 2].end,
				},
			})
		: result;
}

function topLevelJwtEnd(options: {
	segmentCount: number;
	segmentLengths: number[];
	segmentEnds: number[];
}): number | undefined {
	if (
		options.segmentCount >= 5 &&
		options.segmentLengths[2] > 0 &&
		options.segmentLengths[3] > 0 &&
		options.segmentLengths[4] > 0
	) {
		return options.segmentEnds[4];
	}
	return options.segmentCount >= 3 &&
		options.segmentLengths[1] > 0 &&
		options.segmentLengths[2] > 0
		? options.segmentEnds[2]
		: undefined;
}

function scanJwt(position: ScanPosition): SecretScan | undefined {
	if (!position.text.startsWith("eyJ", position.start)) return undefined;
	let segmentStart = position.start + 3;
	let cursor = consumeWhile({
		text: position.text,
		start: segmentStart,
		predicate: isTokenChar,
	});
	if (cursor - segmentStart < 5) return { end: cursor };

	const segmentLengths = [cursor - segmentStart];
	const segmentEnds = [cursor];
	const recentSegments = [
		createJwtSegment({ text: position.text, start: segmentStart, end: cursor }),
	];
	let segmentCount = 1;
	let nestedRange: SecretRange | undefined;
	while (position.text[cursor] === ".") {
		segmentStart = cursor + 1;
		cursor = consumeWhile({
			text: position.text,
			start: segmentStart,
			predicate: isTokenChar,
		});
		segmentCount++;
		recentSegments.push(
			createJwtSegment({
				text: position.text,
				start: segmentStart,
				end: cursor,
			}),
		);
		if (recentSegments.length > 5) recentSegments.shift();
		nestedRange = chooseSecretRange({
			current: nestedRange,
			candidate: findNestedJwtRange(recentSegments),
		});
		if (segmentLengths.length < 5) {
			segmentLengths.push(cursor - segmentStart);
			segmentEnds.push(cursor);
		}
	}

	const topLevelEnd = topLevelJwtEnd({
		segmentCount,
		segmentLengths,
		segmentEnds,
	});
	if (topLevelEnd !== undefined) {
		return { end: topLevelEnd, replacement: "[REDACTED:jwt]" };
	}
	return nestedRange
		? { ...nestedRange, replacement: "[REDACTED:jwt]" }
		: { end: cursor };
}

/**
 * Legacy OpenAI keys are `sk-` followed by base62 (ASCII alphanumeric only —
 * no `-`/`_`). Redact only on a strict shape: at least
 * OPENAI_LEGACY_MIN_SUFFIX alphanumeric chars AND at least one digit. Stopping
 * the suffix at the first non-alphanumeric char means a hyphenated identifier
 * such as `sk-skeleton-loading-placeholder` yields only `skeleton` (8 chars) —
 * far below the bar — so ordinary kebab-case slugs are never touched.
 */
function scanOpenAiLegacyKey(position: ScanPosition): SecretScan | undefined {
	if (!position.text.startsWith("sk-", position.start)) return undefined;
	const suffixStart = position.start + 3;
	let end = suffixStart;
	let hasDigit = false;
	while (
		end < position.text.length &&
		isAsciiAlphaNumeric(position.text[end])
	) {
		const code = codePointOf(position.text[end]);
		if (code >= 48 && code <= 57) hasDigit = true;
		end++;
	}
	return end - suffixStart >= OPENAI_LEGACY_MIN_SUFFIX && hasDigit
		? { end, replacement: "[REDACTED:openai-key]" }
		: { end: Math.max(end, suffixStart) };
}

function scanSecretAt(position: ScanPosition): SecretScan | undefined {
	const initial = position.text[position.start];
	if (initial === "S") return scanSendGridKey(position);
	if (initial === "x") return scanSlackToken(position);
	// `s`: modern `sk-proj-`/`sk-svcacct-`/`sk_live_`/`sk_test_` via the prefix
	// registry, else fall back to the strict legacy `sk-<base62>` scanner.
	if (initial === "s") {
		return scanPrefixedSecret(position) ?? scanOpenAiLegacyKey(position);
	}
	if (
		initial === "A" ||
		initial === "G" ||
		initial === "g" ||
		initial === "r"
	) {
		return scanPrefixedSecret(position);
	}
	return undefined;
}

function redactScannedSecrets(options: RedactScannerOptions): string {
	let cursor = 0;
	let copyFrom = 0;
	let result = "";
	const position: ScanPosition = { text: options.text, start: 0 };

	while (cursor < options.text.length) {
		position.start = cursor;
		const scan = options.scanner(position);
		if (!scan) {
			cursor++;
			continue;
		}
		if (scan.replacement) {
			const replacementStart = scan.start ?? cursor;
			result +=
				options.text.slice(copyFrom, replacementStart) + scan.replacement;
			copyFrom = scan.end;
		}
		cursor = Math.max(cursor + 1, scan.end);
	}

	return copyFrom === 0 ? options.text : result + options.text.slice(copyFrom);
}

function redactTokenSecrets(text: string): string {
	return redactScannedSecrets({ text, scanner: scanSecretAt });
}

function redactJwtSecrets(text: string): string {
	return redactScannedSecrets({ text, scanner: scanJwt });
}

function isPrivateKeyLabel(label: string): boolean {
	if (
		label.length === 0 ||
		label.length > 64 ||
		!label.includes("PRIVATE KEY")
	) {
		return false;
	}
	for (const char of label) {
		const code = codePointOf(char);
		if (char !== " " && (code < 48 || code > 57) && (code < 65 || code > 90)) {
			return false;
		}
	}
	return true;
}

function findUnescapedQuote(position: ScanPosition): number {
	let escaped = false;
	for (let index = position.start; index < position.text.length; index++) {
		const char = position.text[index];
		if (char === "\\") {
			escaped = !escaped;
			continue;
		}
		if (char === '"' && !escaped) return index;
		escaped = false;
	}
	return position.text.length;
}

function redactPrivateKeyBlocks(text: string): string {
	let cursor = 0;
	let result = "";

	while (cursor < text.length) {
		const begin = text.indexOf(PEM_BEGIN, cursor);
		if (begin === -1) return result + text.slice(cursor);

		const labelStart = begin + PEM_BEGIN.length;
		const labelEnd = text.indexOf(PEM_DELIMITER, labelStart);
		if (labelEnd === -1) return result + text.slice(cursor);

		const label = text.slice(labelStart, labelEnd);
		if (!isPrivateKeyLabel(label)) {
			const next = labelEnd + PEM_DELIMITER.length;
			result += text.slice(cursor, next);
			cursor = next;
			continue;
		}

		const contentStart = labelEnd + PEM_DELIMITER.length;
		const endMarker = `-----END ${label}-----`;
		const end = text.indexOf(endMarker, contentStart);
		result += text.slice(cursor, begin) + "[REDACTED:private-key]";
		if (end === -1) {
			cursor = findUnescapedQuote({ text, start: contentStart });
			continue;
		}
		cursor = end + endMarker.length;
	}

	return result;
}

export function redactSecrets(text: string): string {
	return redactJwtSecrets(redactTokenSecrets(redactPrivateKeyBlocks(text)));
}
