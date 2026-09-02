import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock sherpa-onnx-node before importing the module under test.
// The module is loaded via dynamic import(), so we intercept at the module level.
const mockDecode = vi.fn();
const mockGetResult = vi.fn();
const mockAcceptWaveform = vi.fn();
const mockCreateStream = vi.fn(() => ({
	acceptWaveform: mockAcceptWaveform,
}));
const MockOfflineRecognizer = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
	this.createStream = mockCreateStream;
	this.decode = mockDecode;
	this.getResult = mockGetResult;
});

vi.mock("sherpa-onnx-node", () => ({
	default: { OfflineRecognizer: MockOfflineRecognizer },
	OfflineRecognizer: MockOfflineRecognizer,
}));

import { createSttEngine, type SttEngineConfig } from "./stt-engine.js";

const BASE_CONFIG: SttEngineConfig = {
	encoderPath: "/models/encoder.onnx",
	decoderPath: "/models/decoder.onnx",
	tokensPath: "/models/tokens.txt",
};

function loudSamples(count: number): Float32Array {
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) samples[i] = i % 2 === 0 ? 0.5 : -0.5;
	return samples;
}

describe("createSttEngine", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetResult.mockReturnValue({ text: "hello world", tokens: [], timestamps: [] });
	});

	it("returns an object with recognize and release methods", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		expect(engine).toHaveProperty("recognize");
		expect(engine).toHaveProperty("release");
		expect(typeof engine.recognize).toBe("function");
		expect(typeof engine.release).toBe("function");
	});

	it("passes config to OfflineRecognizer with correct featConfig", async () => {
		await createSttEngine(BASE_CONFIG);
		expect(MockOfflineRecognizer).toHaveBeenCalledOnce();
		const config = MockOfflineRecognizer.mock.calls[0][0];
		expect(config.featConfig).toEqual({ sampleRate: 16000, featureDim: 80 });
	});

	it("uses provided paths in modelConfig.whisper", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = MockOfflineRecognizer.mock.calls[0][0];
		expect(config.modelConfig.whisper.encoder).toBe("/models/encoder.onnx");
		expect(config.modelConfig.whisper.decoder).toBe("/models/decoder.onnx");
		expect(config.modelConfig.tokens).toBe("/models/tokens.txt");
	});

	it("sets tailPaddings to 1000", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = MockOfflineRecognizer.mock.calls[0][0];
		expect(config.modelConfig.whisper.tailPaddings).toBe(1000);
	});

	it("defaults numThreads to 4 and provider to 'cpu'", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = MockOfflineRecognizer.mock.calls[0][0];
		expect(config.modelConfig.numThreads).toBe(4);
		expect(config.modelConfig.provider).toBe("cpu");
	});

	it("uses custom numThreads and provider when provided", async () => {
		await createSttEngine({ ...BASE_CONFIG, numThreads: 8, provider: "cuda" });
		const config = MockOfflineRecognizer.mock.calls[0][0];
		expect(config.modelConfig.numThreads).toBe(8);
		expect(config.modelConfig.provider).toBe("cuda");
	});

	it("includes language in config when provided", async () => {
		await createSttEngine({ ...BASE_CONFIG, language: "en" });
		const config = MockOfflineRecognizer.mock.calls[0][0];
		expect(config.modelConfig.whisper.language).toBe("en");
	});

	it("omits language from config when undefined", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = MockOfflineRecognizer.mock.calls[0][0];
		expect(config.modelConfig.whisper).not.toHaveProperty("language");
	});
});

describe("SttEngine.recognize", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetResult.mockReturnValue({ text: "  hello world  ", tokens: [], timestamps: [] });
	});

	it("returns empty string for empty samples", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		const result = await engine.recognize(new Float32Array(0), 16000);
		expect(result).toBe("");
		// Should not create a stream or decode for empty input
		expect(mockCreateStream).not.toHaveBeenCalled();
	});

	it("calls acceptWaveform, decode, getResult and returns trimmed text", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		const samples = loudSamples(1600);
		const result = await engine.recognize(samples, 16000);

		expect(mockCreateStream).toHaveBeenCalledOnce();
		expect(mockAcceptWaveform).toHaveBeenCalledWith({ samples, sampleRate: 16000 });
		expect(mockDecode).toHaveBeenCalledOnce();
		expect(mockGetResult).toHaveBeenCalledOnce();
		expect(result).toBe("hello world");
	});

	it("passes sampleRate through to acceptWaveform", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		await engine.recognize(loudSamples(800), 44100);
		expect(mockAcceptWaveform).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 44100 }));
	});

	it("returns empty string when recognizer returns empty text", async () => {
		mockGetResult.mockReturnValue({ text: "", tokens: [], timestamps: [] });
		const engine = await createSttEngine(BASE_CONFIG);
		const result = await engine.recognize(loudSamples(1600), 16000);
		expect(result).toBe("");
	});
});

describe("SttEngine.release", () => {
	it("is a no-op (no throw)", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		expect(() => engine.release()).not.toThrow();
	});
});
