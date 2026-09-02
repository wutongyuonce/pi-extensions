import { createSingleFlight } from "./single-flight.js";

export interface AvailabilityProbeFlight<T> {
	run(
		key: string,
		probe: () => Promise<T>,
	): {
		promise: Promise<T>;
		joined: boolean;
	};
	clear(): void;
}

/** Create a flight registry whose lifetime belongs to the caller. */
export function createAvailabilityProbeFlight<T>(
	options: Parameters<typeof createSingleFlight<T>>[0] = {},
): AvailabilityProbeFlight<T> {
	const flights = createSingleFlight<T>(options);
	return {
		run(key, probe) {
			const joined = flights.has(key);
			return { promise: flights.run(key, probe), joined };
		},
		clear: () => flights.clear(),
	};
}
