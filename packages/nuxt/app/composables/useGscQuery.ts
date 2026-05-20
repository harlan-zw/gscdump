// Unified analytics query hook. Dispatches browser DuckDB-WASM vs server
// fallback, abort-safe, with typed status enum and opt-in backfill-on-demand.
//
// `site` is a parameter (not global state) so multi-site pages can issue
// independent queries. `serverFallback` is optional — the default POSTs
// AnalysisParams to `/api/__gsc/sites/[siteId]/analyze`. Override if your server
// uses a different contract.

import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'
import type { ComputedRef, Ref, WatchSource } from '@vue/runtime-core'
import { classifyGscError } from '../utils/gsc-error'
import { useGscBackfill } from './_useGscBackfill'
import { useGscQueryDispatcher } from './_useGscQueryDispatcher'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'
import { useGscAnalyzer } from './useGscAnalyzer'
import { _useGscAuthInternal } from './useGscAuth'

export type GscQueryEngine = 'auto' | 'browser' | 'server'

export type GscQueryStatus
  = | 'idle'
    | 'pending'
    | 'success'
    | 'empty'
    | 'error'
    | 'auth-missing'
    | 'rate-limited'
    | 'network'

/**
 * Why a given query ended up on `browser` or `server`. Surfaced for
 * dev tooling so 0% R2 utilisation can be diagnosed without guessing
 * (e.g. opt-in off vs. site not eligible vs. attach failure).
 */
export type GscQueryDecisionReason
  = | 'idle'
    | 'ssr'
    | 'disabled'
    | 'forced:server'
    | 'forced:browser'
    | 'optin:off'
    | 'auto:browser'
    | 'auto:fallback'

export interface GscQueryDecision {
  mode: 'browser' | 'server' | null
  reason: GscQueryDecisionReason
  /** Free-text detail for `auto:fallback` (the underlying error message). */
  detail?: string
}

export interface GscQueryMeta {
  raw: Record<string, unknown> | null
  backfillRequired?: { startDate: string, endDate: string }
  retryAfter?: number
}

export type GscBackfillRunner = ReturnType<typeof useGscBackfill>

export interface UseGscQueryOptions<T> {
  /** Site id (reactive). Required — queries don't dispatch without a site. */
  site: MaybeRefOrGetter<string | null | undefined>
  /** Reactive analysis params (discriminated union by `.type`). */
  params: MaybeRefOrGetter<AnalysisParams>
  /**
   * Transform raw `AnalysisResult` from the browser path into the consumer type.
   * Omit to pass through as-is (return type becomes `AnalysisResult`).
   */
  reshape?: (raw: AnalysisResult) => T
  /**
   * Server fallback override. Defaults to POSTing the params to
   * `/api/__gsc/sites/[siteId]/analyze` and returning the response body.
   */
  serverFallback?: (siteId: string, params: AnalysisParams) => Promise<T>
  /**
   * Force a specific engine. Default `'auto'`. Accepts a getter so callers
   * can swing engine reactively (e.g. flip to `'server'` when the requested
   * range overlaps a known coverage gap). Re-read on every `runQuery` and
   * also included in the watcher graph so changes trigger a refetch.
   */
  engine?: MaybeRefOrGetter<GscQueryEngine>
  /** Extra reactive sources that should trigger refetch. */
  watchSources?: WatchSource[]
  /** Extract meta from the consumer payload. Defaults to `(out as any).meta`. */
  extractMeta?: (out: T) => Record<string, unknown> | null | undefined
  /**
   * Backfill handling. `false` (default) = off. `true` = spin up a dedicated
   * `useGscBackfill()`. Pass an existing runner to share across queries.
   */
  backfill?: boolean | GscBackfillRunner
  /** Gate the query — when `false` it stays idle. */
  enabled?: MaybeRefOrGetter<boolean>
}

export interface UseGscQueryReturn<T> {
  data: Ref<T | null>
  status: Ref<GscQueryStatus>
  pending: ComputedRef<boolean>
  error: Ref<Error | null>
  engine: Ref<'browser' | 'server' | null>
  elapsedMs: Ref<number | null>
  fallbackReason: Ref<string | null>
  /** Why this query ran where it ran. Updated on every dispatch. */
  lastDecision: Ref<GscQueryDecision>
  meta: Ref<GscQueryMeta>
  backfill: GscBackfillRunner | null
  refresh: () => Promise<void>
}

function classifyError(e: unknown): { status: GscQueryStatus, retryAfter?: number } {
  const c = classifyGscError(e)
  return { status: c.status as GscQueryStatus, retryAfter: c.retryAfter }
}

function isEmpty(v: unknown): boolean {
  if (v == null)
    return true
  if (Array.isArray(v))
    return v.length === 0
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>
    for (const key of ['rows', 'results', 'daily', 'items']) {
      const arr = rec[key]
      if (Array.isArray(arr))
        return arr.length === 0
    }
  }
  return false
}

async function defaultServerFallback<T>(siteId: string, params: AnalysisParams): Promise<T> {
  return await useGscAnalyticsClient().analyze<T>(siteId, params)
}

export function useGscQuery<T = AnalysisResult>(opts: UseGscQueryOptions<T>): UseGscQueryReturn<T> {
  const analyzer = useGscAnalyzer(opts.site)
  const dispatcher = useGscQueryDispatcher()

  const data = shallowRef<T | null>(null)
  const status = ref<GscQueryStatus>('idle')
  const error = ref<Error | null>(null)
  const engine = ref<'browser' | 'server' | null>(null)
  const elapsedMs = ref<number | null>(null)
  const fallbackReason = ref<string | null>(null)
  const lastDecision = ref<GscQueryDecision>({ mode: null, reason: 'idle' })
  const meta = ref<GscQueryMeta>({ raw: null })
  const pending = computed(() => status.value === 'pending')

  function extractMeta(out: T): Record<string, unknown> | null {
    if (opts.extractMeta) {
      const m = opts.extractMeta(out)
      return m ?? null
    }
    const m = (out as unknown as { meta?: Record<string, unknown> })?.meta
    return m ?? null
  }

  function captureMeta(out: T): void {
    const raw = extractMeta(out)
    const backfillRequired = (raw as { backfillRequired?: { startDate: string, endDate: string } } | null)?.backfillRequired
    meta.value = backfillRequired ? { raw, backfillRequired } : { raw }
  }

  async function runServer(siteId: string): Promise<void> {
    const t0 = performance.now()
    const fn = opts.serverFallback ?? defaultServerFallback
    const out = await fn(siteId, toValue(opts.params)) as T
    data.value = out
    engine.value = 'server'
    elapsedMs.value = performance.now() - t0
    captureMeta(out)
  }

  async function runBrowser(signal: AbortSignal): Promise<void> {
    const out = await analyzer.analyze(toValue(opts.params), { signal })
    signal.throwIfAborted()
    const shaped = opts.reshape ? opts.reshape(out) : (out as unknown as T)
    data.value = shaped
    engine.value = 'browser'
    elapsedMs.value = (out as unknown as { queryMs?: number }).queryMs ?? null
    captureMeta(shaped)
  }

  let activeController: AbortController | null = null

  async function runQuery(): Promise<void> {
    if (!import.meta.client) {
      status.value = 'idle'
      lastDecision.value = { mode: null, reason: 'ssr' }
      return
    }
    if (opts.enabled && !toValue(opts.enabled)) {
      status.value = 'idle'
      data.value = null
      engine.value = null
      elapsedMs.value = null
      lastDecision.value = { mode: null, reason: 'disabled' }
      return
    }
    const siteId = toValue(opts.site)
    if (!siteId) {
      status.value = 'idle'
      lastDecision.value = { mode: null, reason: 'idle' }
      return
    }
    activeController?.abort()
    const controller = new AbortController()
    activeController = controller
    status.value = 'pending'
    error.value = null
    fallbackReason.value = null

    const decision = dispatcher.pickEngine(_useGscAuthInternal().value, { perCall: toValue(opts.engine) })
    lastDecision.value = decision

    try {
      if (decision.mode === 'server') {
        await runServer(siteId)
      }
      else {
        // Browser-mode: when the caller asked for `auto` we fall back to server
        // on failure; explicit `browser` propagates the error.
        await runBrowser(controller.signal).catch(async (e) => {
          if (e?.name === 'AbortError')
            throw e
          if (decision.requested !== 'auto')
            throw e
          fallbackReason.value = e instanceof Error ? e.message : String(e)
          console.warn('[useGscQuery] browser failed, falling back to server:', fallbackReason.value)
          dispatcher.reportFallback({
            reason: fallbackReason.value,
            at: Date.now(),
            url: typeof location !== 'undefined' ? location.pathname : '',
          })
          lastDecision.value = { mode: 'server', reason: 'auto:fallback', detail: fallbackReason.value }
          await runServer(siteId)
        })
      }
      if (!controller.signal.aborted)
        status.value = isEmpty(data.value) ? 'empty' : 'success'
    }
    catch (e) {
      if ((e as { name?: string })?.name === 'AbortError')
        return
      error.value = e instanceof Error ? e : new Error(String(e))
      const classified = classifyError(e)
      status.value = classified.status
      if (classified.retryAfter != null)
        meta.value = { ...meta.value, retryAfter: classified.retryAfter }
    }
    finally {
      if (activeController === controller)
        activeController = null
    }
  }

  if (import.meta.client) {
    onScopeDispose(() => {
      activeController?.abort()
      activeController = null
    })
  }

  const sources: WatchSource[] = [
    () => toValue(opts.site),
    () => toValue(opts.params),
    ...(opts.watchSources ?? []),
  ]
  if (opts.enabled)
    sources.push(() => toValue(opts.enabled))
  if (opts.engine !== undefined)
    sources.push(() => toValue(opts.engine))
  watch(sources, runQuery, { deep: true, immediate: true })

  let backfill: GscBackfillRunner | null = null
  const b = opts.backfill ?? false
  if (b !== false) {
    backfill = b === true ? useGscBackfill() : b
    watch(() => meta.value.backfillRequired, (req: { startDate: string, endDate: string } | undefined) => {
      if (!req)
        return
      const siteId = toValue(opts.site)
      if (!siteId)
        return
      backfill!.maybeTrigger({ backfillRequired: req }, siteId, runQuery)
    }, { immediate: true })
  }

  return { data, status, pending, error, engine, elapsedMs, fallbackReason, lastDecision, meta, backfill, refresh: runQuery }
}
