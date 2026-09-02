import { spawn } from "node:child_process";

export const FILE_SAMPLE_RATE = 16_000;

const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;

function ffmpegExecutable(): string {
  return process.env.PI_TRANSCRIBE_FFMPEG_PATH?.trim() || "ffmpeg";
}

function installHint(): string {
  switch (process.platform) {
    case "darwin":
      return "On macOS with Homebrew: brew install ffmpeg";
    case "win32":
      return "On Windows: winget install Gyan.FFmpeg";
    default:
      return "On Debian/Ubuntu: sudo apt install ffmpeg (use your distribution's package manager elsewhere)";
  }
}

function missingFfmpegError(executable: string): Error {
  const configured = process.env.PI_TRANSCRIBE_FFMPEG_PATH?.trim();
  const locationHelp = configured
    ? `The configured PI_TRANSCRIBE_FFMPEG_PATH (${configured}) could not be found. Correct it or unset it to use PATH.`
    : "The ffmpeg executable was not found on PATH.";
  return new Error(
    [
      "File transcription requires FFmpeg.",
      locationHelp,
      installHint(),
      "Explain this requirement to the user and ask permission before installing system software, then retry transcribe_file.",
    ].join(" "),
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("File audio decoding was cancelled");
}

export type DecodedFileAudio = {
  pcm: Float32Array;
  seconds: number;
};

/** Decode the first audio stream in a local media file to transcribe.cpp PCM. */
export async function decodeFileAudio(
  path: string,
  signal?: AbortSignal,
): Promise<DecodedFileAudio> {
  signal?.throwIfAborted();
  const executable = ffmpegExecutable();
  const child = spawn(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(FILE_SAMPLE_RATE),
      "-acodec",
      "pcm_f32le",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  return new Promise<DecodedFileAudio>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let stderr = "";
    let terminalError: Error | undefined;

    const onAbort = (): void => {
      terminalError = abortReason(signal!);
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (terminalError) return;
      byteLength += chunk.length;
      if (byteLength > MAX_DECODED_BYTES) {
        terminalError = new Error(
          "Decoded audio exceeds the 128 MiB safety limit (about 35 minutes at 16 kHz mono). Split the media file into smaller parts and retry.",
        );
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(-MAX_STDERR_CHARS);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      terminalError =
        error.code === "ENOENT"
          ? missingFfmpegError(executable)
          : new Error(`Could not start FFmpeg (${executable}): ${error.message}`);
    });

    child.once("close", (code, closeSignal) => {
      signal?.removeEventListener("abort", onAbort);
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || `process exited with code ${code ?? "unknown"}`;
        reject(
          new Error(
            `FFmpeg could not decode the file${closeSignal ? ` (signal ${closeSignal})` : ""}: ${detail}`,
          ),
        );
        return;
      }
      if (byteLength === 0) {
        reject(new Error("FFmpeg decoded no audio samples; the file may not contain an audio stream"));
        return;
      }
      if (byteLength % BYTES_PER_SAMPLE !== 0) {
        reject(new Error(`FFmpeg returned ${byteLength} bytes of incomplete float32 PCM`));
        return;
      }

      const output = Buffer.concat(chunks, byteLength);
      const pcm =
        output.byteOffset % BYTES_PER_SAMPLE === 0
          ? new Float32Array(output.buffer, output.byteOffset, output.byteLength / BYTES_PER_SAMPLE)
          : new Float32Array(Uint8Array.from(output).buffer);
      resolve({ pcm, seconds: pcm.length / FILE_SAMPLE_RATE });
    });
  });
}
