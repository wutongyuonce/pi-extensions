// Post-recognition filter for Whisper's well-known silence/near-silence
// hallucinations. sherpa-onnx-node (and sherpa-onnx itself) don't expose the
// openai-whisper decoder thresholds — `no_speech_threshold`,
// `logprob_threshold`, `compression_ratio_threshold` — so we filter the
// output instead. Combined with the input-side RMS gate this catches the
// long tail without an engine swap.

// Phrases Whisper emits as the *entire* output of a quiet segment. Matched
// against the normalized form (lowercase, punctuation+symbols stripped, whitespace
// collapsed) so "Thanks for watching!" and "thanks  for  watching." both hit.
const HALLUCINATION_PHRASES: ReadonlySet<string> = new Set([
	"thanks for watching",
	"thanks for watching everyone",
	"thank you for watching",
	"please subscribe",
	"please like and subscribe",
	"see you in the next video",
	"see you next time",
	"ill see you in the next video",
	"subtitles by the amaraorg community",
	"transcribed by esoteric",
	"music",
	"applause",
	"silence",
	"you",
	"thank you",
	"bye",
	// Frequent non-English variants (Whisper's multilingual decoder picks these
	// up on quiet segments regardless of the actual spoken language):
	"ご視聴ありがとうございました",
	"次回もお楽しみに",
	"시청해주셔서 감사합니다",
	"다음 영상에서 만나요",
]);

export function isHallucination(text: string): boolean {
	const normalized = normalize(text);
	if (!normalized) return true;
	if (HALLUCINATION_PHRASES.has(normalized)) return true;
	if (isRepetitionLoop(normalized)) return true;
	return false;
}

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\p{P}\p{S}]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

// Catches "1/2 1/2 1/2 1/2", "ok ok ok ok", "yes no yes no yes no" — the
// decoder loop output Whisper falls into on borderline-silent input. Single-
// token repeats need 4 reps so real emphasis ("yeah yeah yeah") is preserved.
function isRepetitionLoop(normalized: string): boolean {
	const tokens = normalized.split(" ").filter(Boolean);
	if (tokens.length < 4) return false;
	for (let groupSize = 1; groupSize <= 3; groupSize++) {
		const minRepeats = groupSize === 1 ? 4 : 3;
		if (tokens.length < groupSize * minRepeats) continue;
		let allMatch = true;
		for (let i = groupSize; i < tokens.length; i++) {
			if (tokens[i] !== tokens[i % groupSize]) {
				allMatch = false;
				break;
			}
		}
		if (allMatch) return true;
	}
	return false;
}
