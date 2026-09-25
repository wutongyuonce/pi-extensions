/**
 * The shared re-check cadence for a cached "nothing here" verdict — the
 * bound both `file-utils.ts`'s nested `.gitignore`/`.pi-lens.json` matcher
 * (#2159/#2071) and `project-lens-config.ts`'s no-config discovery cache
 * (#2483 round 2) use so a negative result is neither re-statted on every
 * call nor cached for the life of the process.
 *
 * A declared leaf module, the same shape as `ledger-bounds.ts` /
 * `spawn-output-cap.ts`: it imports nothing from `clients/`, because
 * `file-utils.ts` already imports `project-lens-config.ts`, and the
 * `clients/` acyclic-imports rule (`no-client-cycles`,
 * `.dependency-cruiser.cjs`) would reject either of those two files
 * importing a constant that lived inside the other. A shared value neither
 * owns is the only way both stay on the same cadence without one importing
 * the other.
 */
export const FRESHNESS_CADENCE_MS = 2_000;
