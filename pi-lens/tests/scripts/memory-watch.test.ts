import { describe, expect, it } from "vitest";
import {
	formatVerdict,
	parseMeminfo,
	shouldPrint,
} from "../../scripts/lib/memory-watch.mjs";

const MEMINFO = [
	"MemTotal:       16376464 kB",
	"MemFree:          204908 kB",
	"MemAvailable:    9481512 kB",
	"Buffers:          151876 kB",
	"Cached:          8724180 kB",
].join("\n");

describe("memory watch sampling (#2042)", () => {
	it("reads MemAvailable, not MemFree", () => {
		// MemFree excludes reclaimable page cache and reads alarmingly low on a
		// healthy runner. MemAvailable is the number that tracks real pressure, so
		// reading the wrong field would make every sample look like an emergency.
		const sample = parseMeminfo(MEMINFO);
		expect(sample.totalMb).toBe(Math.round(16_376_464 / 1024));
		expect(sample.availableMb).toBe(Math.round(9_481_512 / 1024));
		expect(sample.availableMb).not.toBe(Math.round(204_908 / 1024));
	});

	it("refuses to invent numbers from an unparseable meminfo", () => {
		expect(() => parseMeminfo("MemTotal: not-a-number\n")).toThrow();
	});
});

describe("memory watch print policy (#2042)", () => {
	const state = (lastPrintedMb: number | null) => ({
		lastPrintedMb,
		thresholdMb: 1024,
		stepMb: 1024,
	});

	it("always prints the first sample", () => {
		expect(shouldPrint({ availableMb: 12_000 }, state(null))).toBe(true);
	});

	it("stays quiet while memory is plentiful and steady", () => {
		// A line every two seconds for a five-minute suite would bury the test
		// output it is meant to annotate.
		expect(shouldPrint({ availableMb: 11_800 }, state(12_000))).toBe(false);
	});

	it("prints once memory falls a full step", () => {
		expect(shouldPrint({ availableMb: 10_900 }, state(12_000))).toBe(true);
	});

	it("prints every sample below the low-water threshold", () => {
		// Past the threshold each sample is evidence: the last one before a kill
		// is the whole point of the watch.
		expect(shouldPrint({ availableMb: 900 }, state(1000))).toBe(true);
	});
});

describe("memory watch verdict (#2042)", () => {
	const watch = { totalMb: 15_992, lowWaterMb: 143, lowWaterAt: "20:09:27" };

	it("calls a SIGKILL what it is, with the low-water mark", () => {
		const line = formatVerdict({ code: null, signal: "SIGKILL" }, watch);
		expect(line).toContain("KILLED");
		expect(line).toContain("no failing assertion");
		expect(line).toContain("lowWaterAvailableMb=143");
		expect(line).toContain("lowWaterAt=20:09:27");
	});

	it("treats a bare exit 137 as the same shape", () => {
		// A shell between the wrapper and the killed process reports 137 rather
		// than forwarding the signal; both must reach the same verdict.
		expect(formatVerdict({ code: 137, signal: null }, watch)).toContain(
			"KILLED",
		);
	});

	it("does not cry OOM over an ordinary test failure", () => {
		const line = formatVerdict({ code: 1, signal: null }, watch);
		expect(line).not.toContain("KILLED");
		expect(line).toContain("exitCode=1");
	});

	it("reports the low-water mark on success too", () => {
		// The headroom on a passing run is what says whether the next one is safe.
		const line = formatVerdict({ code: 0, signal: null }, watch);
		expect(line).toContain("lowWaterAvailableMb=143");
	});

	it("names the process it was watching, so the kernel's victim pid matches", () => {
		// `dmesg` says "Killed process 2477 (npm)". That is only attributable
		// next to the pid the wrapper was watching.
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ ...watch, childPid: 2477 },
		);
		expect(line).toContain("childPid=2477");
	});
});

/**
 * The verdict must be a reading of its own numbers, not a fixed conclusion.
 *
 * Every exit-137 in this repo's CI history carried the "the OS reclaimed
 * memory" sentence, including three whose own low-water mark said 13 GB of
 * 16 GB was still available (runs 33010136296, 32975604997, 32943340609) —
 * while the green run beside them went LOWER, to 13,096 MB (run 33012307631).
 * Four rounds of diagnosis inherited that false sentence.
 */
describe("memory watch verdict classifies from its own numbers (#2042)", () => {
	// Verbatim from run 33010136296's own verdict line.
	const realKill = {
		totalMb: 15_990,
		lowWaterMb: 13_260,
		lowWaterAt: "20:24:08",
		childPid: 2477,
	};

	it("refuses to blame memory when the box was never short of it", () => {
		const line = formatVerdict({ code: null, signal: "SIGKILL" }, realKill);
		expect(line).not.toContain("the OS reclaimed memory");
		expect(line).toContain("HEADROOM");
		expect(line).toContain("13260 MB of 15990 MB");
		expect(line).toContain("lowWaterAvailableMb=13260");
	});

	it("still blames memory when the mark says the box ran out", () => {
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 15_990, lowWaterMb: 102, lowWaterAt: "12:00:00" },
		);
		expect(line).toContain("the OS reclaimed memory");
		expect(line).not.toContain("HEADROOM");
	});

	it("keeps the [mem-watch] KILLED prefix on both verdicts", () => {
		// scripts/lib/ci-failure-classifier.mjs matches `[mem-watch] KILLED` and
		// quotes the whole line as its posted detail. Both heads must keep the
		// prefix, or a headroom kill silently loses its classification.
		for (const w of [realKill, { ...realKill, lowWaterMb: 102 }]) {
			expect(formatVerdict({ code: null, signal: "SIGKILL" }, w)).toContain(
				"[mem-watch] KILLED",
			);
		}
	});

	it("scales the exhaustion threshold with the box, not a fixed MB", () => {
		// 700 MB left is comfortable on a 16 GB runner and terminal on a 4 GB one.
		const onBigBox = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 15_990, lowWaterMb: 700, lowWaterAt: null },
		);
		const onSmallBox = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 4096, lowWaterMb: 700, lowWaterAt: null },
		);
		expect(onBigBox).toContain("the OS reclaimed memory");
		expect(onSmallBox).toContain("HEADROOM");
	});

	it("defaults to the memory verdict when the numbers are unreadable", () => {
		// Never quieter than the evidence supports: an unparsed meminfo must not
		// turn into a confident "not memory" claim.
		for (const total of [0, Number.NaN]) {
			expect(
				formatVerdict(
					{ code: null, signal: "SIGKILL" },
					{ totalMb: total, lowWaterMb: 13_260, lowWaterAt: null },
				),
			).toContain("the OS reclaimed memory");
		}
	});

	// Round-2 review F3. The fraction alone is not the rule: on a 2 GB box a
	// tenth is 205 MB, so a genuinely starved run with 300 MB left would be
	// called roomy. EXHAUSTION_AVAILABLE_FLOOR_MB is what stops that, and it was
	// unpinned — setting it to 0 left all 17 tests green.
	it("keeps a small box from being called roomy by the fraction alone", () => {
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 2048, lowWaterMb: 300, lowWaterAt: null },
		);
		expect(line).toContain("the OS reclaimed memory");
		expect(line).not.toContain("HEADROOM");
	});

	// Round-2 review F5: `<=` vs `<` at the boundary was unpinned too.
	it("counts a mark exactly at the limit as exhausted", () => {
		// 15,990 * 0.1 = 1599, above the 512 MB floor, so the limit is 1599.
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 15_990, lowWaterMb: 1599, lowWaterAt: null },
		);
		expect(line).toContain("the OS reclaimed memory");
		expect(line).not.toContain("HEADROOM");
	});

	// Round-2 review F4: a 2s sampler cannot rule out a faster spike, and a
	// systemd-oomd pressure kill is memory-shaped and invisible to it. The
	// verdict must state what it measured, not conclude past it.
	it("names the sampling cadence it could not see past", () => {
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ ...realKill, intervalMs: 2000 },
		);
		expect(line).toContain("no sample fell below");
		expect(line).toContain("2000ms sampling");
		expect(line).toContain("systemd-oomd");
		expect(line).not.toContain("a worker or heap knob will not fix it");
	});

	it("leaves an ordinary failure alone whatever the headroom", () => {
		const line = formatVerdict({ code: 1, signal: null }, realKill);
		expect(line).not.toContain("HEADROOM");
		expect(line).not.toContain("the OS reclaimed memory");
		expect(line).toContain("exitCode=1");
	});
});
