// Streaming linear-interpolation resampler for int16 little-endian PCM.
//
// Why not polyphase FIR / soxr / libsamplerate? Speech is bandwidth-limited
// well below the 8 kHz Nyquist of our 16 kHz output, and Whisper's mel-
// filterbank is forgiving of mild aliasing — the issue reporter verified
// peak amplitude within rounding error across 16/44.1/48/96 kHz inputs.
// Pulling in a wasm/native dep would buy nothing perceptually and would
// change the Buffer-in / Buffer-out contract the pipeline is built on.
//
// State persists across calls so chunk boundaries don't introduce clicks:
// `prev` is the most recent input sample, `frac` is the next output
// position measured in source-sample units relative to that prev, kept in
// [0, 1) after each input sample is consumed by sliding the window forward.

const BYTES_PER_INT16 = 2;
const INT16_MIN = -32768;
const INT16_MAX = 32767;

export class Int16LinearResampler {
	private readonly step: number;
	private prev = 0;
	private frac = 0;
	private primed = false;

	constructor(sourceRate: number, targetRate: number) {
		if (sourceRate <= 0 || targetRate <= 0) {
			throw new Error(`Int16LinearResampler: rates must be positive (got ${sourceRate} → ${targetRate})`);
		}
		this.step = sourceRate / targetRate;
	}

	process(input: Buffer): Buffer {
		const inSampleCount = Math.floor(input.length / BYTES_PER_INT16);
		if (inSampleCount === 0) return Buffer.alloc(0);

		// Loose upper bound: the loop emits at most ⌈n/step⌉ samples per call,
		// plus one for the in-flight fractional carry. Two extra slots is
		// cheap insurance against off-by-one in either direction.
		const maxOut = Math.ceil(inSampleCount / this.step) + 2;
		const out = Buffer.allocUnsafe(maxOut * BYTES_PER_INT16);
		let outIdx = 0;

		for (let i = 0; i < inSampleCount; i++) {
			const cur = input.readInt16LE(i * BYTES_PER_INT16);
			if (!this.primed) {
				this.prev = cur;
				this.primed = true;
				continue;
			}
			while (this.frac < 1) {
				const v = Math.round(this.prev + (cur - this.prev) * this.frac);
				const clamped = v < INT16_MIN ? INT16_MIN : v > INT16_MAX ? INT16_MAX : v;
				out.writeInt16LE(clamped, outIdx * BYTES_PER_INT16);
				outIdx++;
				this.frac += this.step;
			}
			this.frac -= 1;
			this.prev = cur;
		}

		return out.subarray(0, outIdx * BYTES_PER_INT16);
	}
}
