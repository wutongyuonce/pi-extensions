import type { Observation } from "../../session-ledger/index.js";

export type ObservationPoolMetrics = {
	observationTokens: number;
	targetTokens: number;
	tokensOverTarget: number;
	fullness: number;
	activeObservationCount: number;
	droppableCount: number;
	maxDropsAllowed: number;
	overTarget: boolean;
	ready: boolean;
};

export function observationTokenSum(observations: readonly { tokenCount: number }[]): number {
	return observations.reduce((sum, observation) => sum + observation.tokenCount, 0);
}

export function observationPoolFullness(observationTokens: number, targetTokens: number): number {
	if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
	if (!Number.isFinite(targetTokens) || targetTokens <= 0) return 0;
	return observationTokens / targetTokens;
}

export function droppableObservationCount(observations: readonly Observation[]): number {
	return observations.length;
}

export function maxDropCountForPool(observations: readonly Observation[], observationTokens: number, targetTokens: number): number {
	const activeObservationCount = observations.length;
	if (activeObservationCount === 0) return 0;
	if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
	if (!Number.isFinite(targetTokens) || targetTokens < 0) return 0;

	const tokensOverTarget = observationTokens - targetTokens;
	if (tokensOverTarget <= 0) return 0;

	const averageObservationTokens = observationTokens / activeObservationCount;
	if (!Number.isFinite(averageObservationTokens) || averageObservationTokens <= 0) return 0;

	const estimatedDrops = Math.ceil(tokensOverTarget / averageObservationTokens);
	return Math.min(activeObservationCount, Math.max(1, estimatedDrops));
}

export function observationPoolMetrics(
	observations: readonly Observation[],
	targetTokens: number,
): ObservationPoolMetrics {
	const observationTokens = observationTokenSum(observations);
	const fullness = observationPoolFullness(observationTokens, targetTokens);
	const activeObservationCount = observations.length;
	const droppableCount = droppableObservationCount(observations);
	const tokensOverTarget = Math.max(0, observationTokens - targetTokens);
	const maxDropsAllowed = maxDropCountForPool(observations, observationTokens, targetTokens);
	const overTarget = Number.isFinite(targetTokens) && targetTokens >= 0 && observationTokens > targetTokens;
	return {
		observationTokens,
		targetTokens,
		tokensOverTarget,
		fullness,
		activeObservationCount,
		droppableCount,
		maxDropsAllowed,
		overTarget,
		ready: overTarget && maxDropsAllowed > 0,
	};
}
