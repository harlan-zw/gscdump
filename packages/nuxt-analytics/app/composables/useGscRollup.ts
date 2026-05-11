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
import { _useGscAnalyticsContext } from './useGscAnalytics'
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
  const envelope = shallowRef<RollupEnvelope<T> | null>(null)
  const loading = ref(false)
  const ctx = tryUseContext()

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    const rid = toValue(rollupId)
    if (!id || !rid) {
      envelope.value = null
      return
    }
    loading.value = true
    envelope.value = await fetchOne<T>(id, rid, ctx, toValue(opts.range) ?? null)
    loading.value = false
  }

  watch(
    () => [toValue(siteId), toValue(rollupId), toValue(opts.range)?.start, toValue(opts.range)?.end],
    refresh,
    { immediate: true },
  )

  const data = computed<T | null>(() => envelope.value?.payload ?? null)
  return { data, envelope, loading: loading as Readonly<Ref<boolean>>, refresh }
}

/** Fetch N rollups for one site. */
export function useGscRollups<T = unknown>(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  rollupIds: RollupsInput,
  opts: UseGscRollupOptions = {},
): UseGscRollupsReturn<T> {
  const ctx = tryUseContext()

  const envelopes = ref<Record<string, RollupEnvelope<T> | null>>({})
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const sid = toValue(siteId)
    const rids = normaliseRollups(toValue(rollupIds))
    if (!sid || rids.length === 0) {
      envelopes.value = {}
      return
    }
    loading.value = true
    const range = toValue(opts.range) ?? null
    const next: Record<string, RollupEnvelope<T> | null> = {}
    try {
      await Promise.all(rids.map(async (rid) => {
        next[rid] = await fetchOne<T>(sid, rid, ctx, range)
      }))
      envelopes.value = next
    }
    finally {
      loading.value = false
    }
  }

  watch(
    () => [toValue(siteId), normaliseRollups(toValue(rollupIds)).join(','), toValue(opts.range)?.start, toValue(opts.range)?.end],
    refresh,
    { immediate: true },
  )

  return {
    get: (rollupId: string) => envelopes.value[rollupId] ?? null,
    payload: (rollupId: string) => envelopes.value[rollupId]?.payload ?? null,
    envelopes,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
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
  const ctx = tryUseContext()
  const envelopes = ref<Record<string, RollupEnvelope<T> | null>>({})
  const loading = ref(false)
  const progress = ref<{ completed: number, total: number }>({ completed: 0, total: 0 })
  // Ensures late-arriving promises from a superseded run don't mutate state
  // for the current run (e.g. when the range changes rapidly).
  let runToken = 0

  async function refresh(): Promise<void> {
    const token = ++runToken
    const siteIds = normaliseSites(toValue(sites))
    const rid = toValue(rollupId)
    if (siteIds.length === 0 || !rid) {
      envelopes.value = {}
      progress.value = { completed: 0, total: 0 }
      return
    }
    loading.value = true
    // Seed envelopes with nulls so the UI can render skeleton rows before any
    // fetch resolves. Writes land incrementally as each site returns.
    const seeded: Record<string, RollupEnvelope<T> | null> = {}
    for (const sid of siteIds) seeded[sid] = null
    envelopes.value = seeded
    progress.value = { completed: 0, total: siteIds.length }
    const range = toValue(opts.range) ?? null
    try {
      await Promise.all(siteIds.map(async (sid) => {
        const env = await fetchOne<T>(sid, rid, ctx, range)
        if (token !== runToken)
          return
        envelopes.value = { ...envelopes.value, [sid]: env }
        progress.value = { completed: progress.value.completed + 1, total: siteIds.length }
      }))
    }
    finally {
      if (token === runToken)
        loading.value = false
    }
  }

  watch(
    () => [normaliseSites(toValue(sites)).join(','), toValue(rollupId), toValue(opts.range)?.start, toValue(opts.range)?.end],
    refresh,
    { immediate: true },
  )

  return {
    envelopes,
    loading: loading as Readonly<Ref<boolean>>,
    progress: progress as Readonly<Ref<{ completed: number, total: number }>>,
    refresh,
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

async function fetchOne<T>(
  siteId: string,
  rollupId: string,
  ctx: ReturnType<typeof tryUseContext>,
  range: { start: string, end: string } | null = null,
): Promise<RollupEnvelope<T> | null> {
  ctx?.patchProgress(siteId, {
    source: 'rollup',
    stage: 'manifest',
    filesTotal: 1,
    filesAttached: 0,
    startedAt: Date.now(),
    error: undefined,
    endedAt: undefined,
  })
  try {
    const env = await useGscAnalyticsClient().getRollup<T>(
      siteId,
      rollupId,
      range ? { start: range.start, end: range.end } : undefined,
    )
    ctx?.patchProgress(siteId, { stage: 'ready', filesAttached: 1, endedAt: Date.now() })
    return env
  }
  catch (err: unknown) {
    const status = (err as { statusCode?: number, status?: number })?.statusCode
      ?? (err as { status?: number })?.status
    if (status === 404) {
      ctx?.patchProgress(siteId, { stage: 'ready', filesAttached: 1, endedAt: Date.now() })
      return null
    }
    const msg = err instanceof Error ? err.message : String(err)
    ctx?.patchProgress(siteId, { stage: 'error', error: msg, endedAt: Date.now() })
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

function tryUseContext(): ReturnType<typeof _useGscAnalyticsContext> | null {
  try {
    return _useGscAnalyticsContext()
  }
  catch {
    return null
  }
}
