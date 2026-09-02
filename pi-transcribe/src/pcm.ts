/**
 * Coalesces Int16 recorder frames into one Float32 PCM buffer. Kept free of
 * imports so eagerly loaded modules can share it without pulling in the native
 * recorder that audio.ts loads.
 */
export function convertFrames(frames: readonly Int16Array[]): Float32Array {
  const sampleCount = frames.reduce((total, frame) => total + frame.length, 0);
  const pcm = new Float32Array(sampleCount);
  let offset = 0;

  for (const frame of frames) {
    for (let index = 0; index < frame.length; index += 1) {
      pcm[offset + index] = (frame[index] ?? 0) / 32_768;
    }
    offset += frame.length;
  }

  return pcm;
}
