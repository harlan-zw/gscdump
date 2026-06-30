import type {
  ListLiveFilter,
  ManifestEntry,
  SyncState,
  SyncStateDetail,
  SyncStateFilter,
  SyncStateKind,
  SyncStateScope,
  Watermark,
  WatermarkFilter,
  WatermarkScope,
} from './storage'
import { inferLegacyTier, inferSearchType } from './layout'

interface MatchOptions {
  ignoreUserId?: boolean
}

export function manifestEntryKey(entry: Pick<ManifestEntry, 'objectKey'>): string {
  return entry.objectKey
}

export function watermarkKey(watermark: WatermarkScope): string {
  return `${watermark.userId}|${watermark.siteId ?? ''}|${watermark.table}`
}

export function syncStateKey(state: SyncStateScope): string {
  return `${state.userId}|${state.siteId ?? ''}|${state.table}|${state.date}|${inferSearchType(state)}`
}

export function matchesManifestEntryFilter(
  entry: ManifestEntry,
  filter: ListLiveFilter,
  options: MatchOptions = {},
): boolean {
  if (!options.ignoreUserId && entry.userId !== filter.userId)
    return false
  if (filter.siteId !== undefined && entry.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && entry.table !== filter.table)
    return false
  if (filter.partitions && !filter.partitions.includes(entry.partition))
    return false
  if (filter.tier !== undefined && inferLegacyTier(entry) !== filter.tier)
    return false
  if (filter.searchType !== undefined && inferSearchType(entry) !== filter.searchType)
    return false
  return true
}

export function matchesWatermarkFilter(
  watermark: Watermark,
  filter: WatermarkFilter,
  options: MatchOptions = {},
): boolean {
  if (!options.ignoreUserId && watermark.userId !== filter.userId)
    return false
  if (filter.siteId !== undefined && watermark.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && watermark.table !== filter.table)
    return false
  return true
}

export function matchesSyncStateFilter(
  state: SyncState,
  filter: SyncStateFilter,
  options: MatchOptions = {},
): boolean {
  if (!options.ignoreUserId && state.userId !== filter.userId)
    return false
  if (filter.siteId !== undefined && state.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && state.table !== filter.table)
    return false
  if (filter.state !== undefined && state.state !== filter.state)
    return false
  if (filter.searchType !== undefined && inferSearchType(state) !== filter.searchType)
    return false
  return true
}

export function mergeSyncState(
  existing: SyncState | undefined,
  scope: SyncStateScope,
  state: SyncStateKind,
  detail?: SyncStateDetail,
): SyncState {
  const at = detail?.at ?? Date.now()
  const attemptsBump = state === 'inflight' ? 1 : 0
  if (!existing) {
    return {
      userId: scope.userId,
      siteId: scope.siteId,
      table: scope.table,
      date: scope.date,
      state,
      updatedAt: at,
      attempts: attemptsBump,
      error: detail?.error,
      ...(scope.searchType !== undefined ? { searchType: scope.searchType } : {}),
    }
  }
  return {
    ...existing,
    state,
    updatedAt: at,
    attempts: existing.attempts + attemptsBump,
    error: state === 'done' ? undefined : (detail?.error ?? existing.error),
  }
}
