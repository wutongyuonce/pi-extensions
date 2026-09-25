/**
 * #1622 / #1419 precedent: what a demoted finding shows where its cached line
 * number used to be. The finding survives, the untrustworthy coordinate does
 * not. Shared base marker so every freshness gate (dependency-drift blockers,
 * cached-scanner staleness, #1641's past-EOF gate) renders the same "this
 * coordinate is no longer trustworthy" vocabulary — a caller with a more
 * specific reason appends its own suffix rather than inventing a parallel
 * marker string.
 *
 * #1631 review V2: lives in its own leaf module rather than `runtime-turn.ts`
 * (the turn orchestrator) so a low-level store like `widget-state.ts` can use
 * the marker without importing a high-level orchestration module — `madge
 * --circular` went from 0 to 45 cycles when `widget-state.ts` imported this
 * constant from `runtime-turn.ts`, and this repo ships that circular-import
 * check as a product feature.
 */
export const STALE_LINE_MARKER = "[stale — re-run to confirm]";
