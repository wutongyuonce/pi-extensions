// decibri delivers Int16 LE; the STT engine wants Float32 in [-1, +1].

const BYTES_PER_INT16_SAMPLE = 2;
const INT16_FULL_SCALE = 0x8000;

export function bufferToFloat32(buf: Buffer): Float32Array {
	const sampleCount = buf.length / BYTES_PER_INT16_SAMPLE;
	const samples = new Float32Array(sampleCount);
	for (let i = 0, j = 0; i < buf.length; i += BYTES_PER_INT16_SAMPLE, j++) {
		samples[j] = buf.readInt16LE(i) / INT16_FULL_SCALE;
	}
	return samples;
}

export function computeRmsInt16(buf: Buffer): number {
	const sampleCount = Math.floor(buf.length / BYTES_PER_INT16_SAMPLE);
	if (sampleCount === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < sampleCount; i++) {
		const s = buf.readInt16LE(i * BYTES_PER_INT16_SAMPLE) / INT16_FULL_SCALE;
		sumSquares += s * s;
	}
	const rms = Math.sqrt(sumSquares / sampleCount);
	return clamp01(rms);
}

export function computeRmsFloat32(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
	return Math.sqrt(sumSquares / samples.length);
}

export function clamp01(n: number): number {
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

export const BYTES_PER_INT16 = BYTES_PER_INT16_SAMPLE;

/** How many Int16 samples sit in a raw PCM chunk. */
export function samplesInInt16Chunk(chunk: Buffer): number {
	return chunk.length / BYTES_PER_INT16_SAMPLE;
}
