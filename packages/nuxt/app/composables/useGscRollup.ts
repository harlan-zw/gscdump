// Rollup fetchers.
//
//   useGscRollup(site, id)             → { data, envelope, loading, refresh }
//   useGscRollups(site, [id, ...])     → { get, payload, envelopes, loading, refresh }
//   useGscRollupFanout(sites, id)      → { envelopes, loading, refresh }
//
// The single/multi-site overload on `useGscRollups` from the previous API was
// split into three focused hooks so each has one return shape.
//
// Progress flows to the shared analytics map so <GscBootProgress> lights up.

import type { RollupEnvelope } from '@gscdump/contracts'
import type { SiteListItem } from './useGscAnalytics'
import { useGscResource } from './_useGscResource'
import { useGscAnalyticsContext } from './useGscAnalytics'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

type RollupsInput = MaybeRefOrGetter<string | readonly string[]>
type SiteLike = string | { id: string } | SiteListItem

export interface UseGscRollupReturn<T> {
  data: Ref<T | null>
  envelope: Ref<RollupEnvelope<T> | null>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export interface UseGscRollupsReturn<T> {
  get: (rollupId: string) => RollupEnvelope<T> | null
  payload: (rollupId: string) => T | null
  envelopes: Ref<Record<string, RollupEnvelope<T> | null>>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export interface UseGscRollupFanoutReturn<T> {
  /** `{ [siteId]: envelope | null }` — null for sites missing the rollup. */
  envelopes: Ref<Record<string, RollupEnvelope<T> | null>>
  loading: Readonly<Ref<boolean>>
  /**
   * How many fan-out fetches have resolved so far (incl. nulls). Useful for
   *  showing "loaded X/Y" hints in tiers where each site is a live API call.
   */
  progress: Readonly<Ref<{ completed: number, total: number }>>
  refresh: () => Promise<void>
}

export interface UseGscRollupOptions {
  /**
   * Optional reactive `{ start, end }` ISO-date window. When provided, the
   * endpoint is free to synthesize the rollup for that window (how it does
   * so is host-specific). Rollups that are range-agnostic (e.g. the
   * client-sliced `daily_totals`) safely ignore these params.
   */
  range?: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>
}

/** Fetch one rollup for one site. */
export function useGscRollup<T = unknown>(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  rollupId: MaybeRefOrGetter<string>,
  opts: UseGscRollupOptions = {},
): UseGscRollupReturn<T> {
  const ctx = useGscAnalyticsContext()
  const client = useGscAnalyticsClient()
  const resource = useGscResource<[string, string], RollupEnvelope<T> | null>({
    namespace: 'gsc-rollup',
    keys: [siteId, rollupId],
    fetcher: (id, rid) => fetchOne<T>(client, id, rid, ctx, toValue(opts.range) ?? null),
    watchSources: [() => toValue(opts.range)?.start, () => toValue(opts.range)?.end],
    isEmpty: env => env == null,
  })

  return {
    data: computed<T | null>(() => resource.data.value?.payload ?? null),
    envelope: resource.data as unknown as Ref<RollupEnvelope<T> | null>,
    loading: resource.loading as unknown as Readonly<Ref<boolean>>,
    refresh: resource.refresh,
  }
}

/** Fetch N rollups for one site. */
export function useGscRollups<T = unknown>(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  rollupIds: RollupsInput,
  opts: UseGscRollupOptions = {},
): UseGscRollupsReturn<T> {
  const ctx = useGscAnalyticsContext()
  const client = useGscAnalyticsClient()
  const rollupKey = computed(() => encodeStringList(normaliseRollups(toValue(rollupIds))))
  const resource = useGscResource<[string, string], Record<string, RollupEnvelope<T> | null>>({
    namespace: 'gsc-rollups',
    keys: [siteId, rollupKey],
    fetcher: async (sid, encoded) => {
      const rids = decodeStringList(encoded)
      const next: Record<string, RollupEnvelope<T> | null> = {}
      const range = toValue(opts.range) ?? null
      await Promise.all(rids.map(async (rid) => {
        next[rid] = await fetchOne<T>(client, sid, rid, ctx, range)
      }))
      return next
    },
    watchSources: [() => toValue(opts.range)?.start, () => toValue(opts.range)?.end],
    isEmpty: value => Object.keys(value).length === 0,
  })
  const envelopes = computed<Record<string, RollupEnvelope<T> | null>>(() => resource.data.value ?? {})

  return {
    get: (rollupId: string) => envelopes.value[rollupId] ?? null,
    payload: (rollupId: string) => envelopes.value[rollupId]?.payload ?? null,
    envelopes: envelopes as unknown as Ref<Record<string, RollupEnvelope<T> | null>>,
    loading: resource.loading as unknown as Readonly<Ref<boolean>>,
    refresh: resource.refresh,
  }
}

/**
 * Fan one rollup id across N sites — returns `{ [siteId]: envelope | null }`.
 * Used by the "all sites" overview page; composes without an overload.
 */
export function useGscRollupFanout<T = unknown>(
  sites: MaybeRefOrGetter<readonly SiteLike[] | null | undefined>,
  rollupId: MaybeRefOrGetter<string>,
  opts: UseGscRollupOptions = {},
): UseGscRollupFanoutReturn<T> {
  const ctx = useGscAnalyticsContext()
  const client = useGscAnalyticsClient()
  const progress = ref<{ completed: number, total: number }>({ completed: 0, total: 0 })
  const siteKey = computed(() => encodeStringList(normaliseSites(toValue(sites))))
  const resource = useGscResource<[string, string], Record<string, RollupEnvelope<T> | null>>({
    namespace: 'gsc-rollup-fanout',
    keys: [siteKey, rollupId],
    fetcher: async (encoded, rid) => {
      const siteIds = decodeStringList(encoded)
      progress.value = { completed: 0, total: siteIds.length }
      const range = toValue(opts.range) ?? null
      const next: Record<string, RollupEnvelope<T> | null> = {}
      await Promise.all(siteIds.map(async (sid) => {
        next[sid] = await fetchOne<T>(client, sid, rid, ctx, range)
        progress.value = { completed: progress.value.completed + 1, total: siteIds.length }
      }))
      return next
    },
    watchSources: [() => toValue(opts.range)?.start, () => toValue(opts.range)?.end],
    isEmpty: value => Object.keys(value).length === 0,
  })
  const envelopes = computed<Record<string, RollupEnvelope<T> | null>>(() => resource.data.value ?? {})
  watch(resource.loading, (loading) => {
    if (loading)
      return
    if (!resource.data.value)
      progress.value = { completed: 0, total: 0 }
  }, { immediate: true })

  return {
    envelopes: envelopes as unknown as Ref<Record<string, RollupEnvelope<T> | null>>,
    loading: resource.loading as unknown as Readonly<Ref<boolean>>,
    progress: progress as Readonly<Ref<{ completed: number, total: number }>>,
    refresh: resource.refresh,
  }
}

function normaliseSites(input: unknown): string[] {
  if (!input)
    return []
  const list = Array.isArray(input) ? input : [input]
  const out: string[] = []
  for (const s of list) {
    if (typeof s === 'string') {
      if (s)
        out.push(s)
    }
    else if (s && typeof s === 'object' && 'id' in s && typeof s.id === 'string' && s.id) {
      out.push(s.id)
    }
  }
  return out
}

function encodeStringList(values: string[]): string {
  return values.length > 0 ? JSON.stringify(values) : ''
}

function decodeStringList(encoded: string): string[] {
  const parsed = JSON.parse(encoded) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
}

async function fetchOne<T>(
  client: ReturnType<typeof useGscAnalyticsClient>,
  siteId: string,
  rollupId: string,
  ctx: ReturnType<typeof useGscAnalyticsContext>,
  range: { start: string, end: string } | null = null,
): Promise<RollupEnvelope<T> | null> {
  ctx.patchProgress(siteId, {
    source: 'rollup',
    stage: 'manifest',
    filesTotal: 1,
    filesAttached: 0,
    startedAt: Date.now(),
    error: undefined,
    endedAt: undefined,
  })
  try {
    const env = await client.getRollup<T>(
      siteId,
      rollupId,
      range ? { start: range.start, end: range.end } : undefined,
    )
    ctx.patchProgress(siteId, { stage: 'ready', filesAttached: 1, endedAt: Date.now() })
    return env
  }
  catch (err: unknown) {
    const status = (err as { statusCode?: number, status?: number })?.statusCode
      ?? (err as { status?: number })?.status
    if (status === 404) {
      ctx.patchProgress(siteId, { stage: 'ready', filesAttached: 1, endedAt: Date.now() })
      return null
    }
    const msg = err instanceof Error ? err.message : String(err)
    ctx.patchProgress(siteId, { stage: 'error', error: msg, endedAt: Date.now() })
    return null
  }
}

function normaliseRollups(input: unknown): string[] {
  if (!input)
    return []
  if (typeof input === 'string')
    return input ? [input] : []
  if (Array.isArray(input))
    return input.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return []
}
