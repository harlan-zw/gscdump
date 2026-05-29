// Public compaction surface (`@gscdump/engine/compaction`).
//
// Hosts need the engine's tier-subsumption verdict in places the engine can't
// orchestrate for them: a coverage/budget planner sizing the read set, a drift
// auditor counting wasted overlap, a per-(site, table) due-check that must read
// through the host's own cached manifest store. All of these are pure functions
// over `ManifestEntry[]` the host already holds — exposing them here keeps the
// host in lockstep with `runSQL`'s resolver (which dedupes the same way) without
// the host reaching into engine internals or the engine owning the host's store.
//
// Write-time retire of the subsumed set is the one piece that IS engine-owned
// I/O — see `StorageEngine.reconcileSubsumed`.

import { countRawDailies, RAW_DAILY_COMPACT_THRESHOLD } from './compaction'

export { dedupeOverlappingTiers, splitOverlappingTiers } from './compaction'

/**
 * Host-policy predicate: true once a table's live raw-daily count crosses the
 * engine's daily→weekly compaction gate. Wraps the internal threshold so hosts
 * decide "is compaction due?" without importing the constant or the counter.
 *
 * Pure — pass the entries the host already fetched (typically via its own cached
 * manifest store, so the hot-path check stays on the host's cache rather than
 * forcing an uncached read through the engine).
 */
export function isRawDailyCompactionDue(
  entries: ReadonlyArray<{ tier?: string | null, partition: string }>,
): boolean {
  return countRawDailies(entries) > RAW_DAILY_COMPACT_THRESHOLD
}
