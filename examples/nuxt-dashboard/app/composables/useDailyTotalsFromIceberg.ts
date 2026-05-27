// Multi-site `daily_totals` via the Iceberg `dates` table + browser DuckDB-WASM.
//
// Replaces `useGscRollupFanout(sites, 'daily_totals')` on the home page. Per-
// site progressive load: each site's parquet downloads and queries run
// independently, so rows light up in the table as soon as their data lands
// (the slowest site doesn't gate the fastest).
//
// Per-site lifecycle, all running concurrently across `sites`:
//   1. `manifest` — fetch `analysis-sources?tables=dates` for THIS site,
//      learn the parquet URLs.
//   2. `wasm` — wait on the shared DuckDB-WASM boot (one promise across all
//      sites — booted lazily on first arrival).
//   3. `attach` — download THIS site's parquet files via `fetch`, register
//      them as DuckDB buffer files, build a per-site view.
//   4. `ready` — run the per-site daily-totals query, materialise rows,
//      write the envelope. The home-page table row populates here.
//
// Each step calls `analyticsCtx.patchProgress(siteId, …)` so the existing
// `<GscBootProgress />` component (in the layout) shows live per-site stage
// + file counts without any UI plumbing on the page itself.

import type { FileResolutionResponse, RollupEnvelope } from '@gscdump/contracts'
import type { OpfsAttachedHandle } from '@gscdump/engine-duckdb-wasm'
import { gscQueries } from '../../layers/gsc/app/queries/gsc'
import { useGscRpc } from '#imports'

export interface DailyTotalRow {
  date: number // unix ms
  clicks: number
  impressions: number
  sum_position: number
  anonymizedImpressionsPct: number
}

interface SiteLike { id: string }

export interface UseDailyTotalsFromIcebergReturn {
  /** `{ [siteId]: RollupEnvelope<DailyTotalRow[]> | null }` — sites populate progressively as their queries complete. */
  envelopes: Ref<Record<string, RollupEnvelope<DailyTotalRow[]> | null>>
  loading: Readonly<Ref<boolean>>
  /** Coarse "X of Y sites ready" counter for headline copy. */
  progress: Readonly<Ref<{ completed: number, total: number }>>
  /** Last error encountered by any site. Per-site errors land on the shared progress map (read via `useGscBootProgress`). */
  error: Readonly<Ref<Error | null>>
  refresh: () => Promise<void>
}

export interface UseDailyTotalsFromIcebergOptions {
  range?: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>
  /**
   * Persist downloaded parquet files in OPFS, keyed by Iceberg `contentHash`.
   * Warm visits with the same snapshot skip the network entirely. Default true.
   */
  useOpfsCache?: boolean
}

interface DateRow {
  date: string // YYYY-MM-DD from DuckDB DATE cast to text
  clicks: number
  impressions: number
  sum_position: number
  anonymized_impressions_pct: number
}

// View-name segment must be a SQL identifier. Site IDs are `s_<base64>`; the
// `s_` prefix is fine but base64 chars `/` and `+` aren't — sanitise just in
// case (current ids are URL-safe base64, but don't bet downstream sites are).
function sqlIdent(siteId: string): string {
  return siteId.replace(/\W/g, '_')
}

export function useDailyTotalsFromIceberg(
  sites: MaybeRefOrGetter<readonly SiteLike[] | null | undefined>,
  opts: UseDailyTotalsFromIcebergOptions = {},
): UseDailyTotalsFromIcebergReturn {
  const envelopes = ref<Record<string, RollupEnvelope<DailyTotalRow[]> | null>>({})
  const loading = ref(false)
  const progress = ref<{ completed: number, total: number }>({ completed: 0, total: 0 })
  const error = ref<Error | null>(null)
  let runToken = 0

  const rpc = useGscRpc()
  const analyticsConfig = useGscAnalyticsConfig()
  // Shared per-site progress map — `<GscBootProgress />` already in the layout
  // reads this. Each site is its own row with live stage + file-count chips.
  const analyticsCtx = useGscAnalyticsContext()

  async function refresh(): Promise<void> {
    const token = ++runToken
    if (!import.meta.client)
      return
    const siteIds = (toValue(sites) ?? []).map(s => s.id).filter(Boolean)
    const range = toValue(opts.range) ?? null

    error.value = null
    if (!siteIds.length || !range?.start || !range?.end) {
      envelopes.value = {}
      progress.value = { completed: 0, total: 0 }
      return
    }

    loading.value = true
    progress.value = { completed: 0, total: siteIds.length }
    envelopes.value = Object.fromEntries(siteIds.map(id => [id, null]))

    // Seed each site at `manifest` stage so the boot-progress UI renders the
    // full set up front with shimmer bars — the user sees activity for every
    // site immediately, not just the ones that have already resolved.
    const startedAt = Date.now()
    for (const id of siteIds)
      analyticsCtx.patchProgress(id, { stage: 'manifest', source: 'duckdb', filesAttached: 0, filesTotal: 0, startedAt, endedAt: undefined, error: undefined })

    // Shared DuckDB-WASM boot — kicked off in parallel with the first
    // analysis-sources fetches. Every site awaits this promise before its own
    // `attach` step.
    // Shared boot — process-wide. ~800ms boot cost amortised across every
    // refresh on the home page (date-range changes, etc.) instead of paid
    // on each one.
    const bundleBase = (analyticsConfig as { duckdbBundleBase?: string }).duckdbBundleBase
    const bootPromise = sharedGscDuckDBWasm(bundleBase)

    const useOpfsCache = opts.useOpfsCache ?? true

    let boot: Awaited<typeof bootPromise> | null = null
    let sitesReady = 0

    async function loadSite(publicId: string): Promise<void> {
      const siteStart = Date.now()
      const mark = (phase: string): PerformanceMark => performance.mark(`gsc:${publicId}:${phase}`)
      mark('start')
      let perSiteConn: Awaited<ReturnType<Awaited<typeof bootPromise>['db']['connect']>> | null = null
      let opfsHandle: OpfsAttachedHandle | null = null
      try {
        // ── manifest ────────────────────────────────────────────────────
        const res = await rpc.query(
          gscQueries.analysisSources(publicId, ['dates'], {
            searchType: 'web',
            start: range.start,
            end: range.end,
          }),
          { silent: true },
        ).catch(() => null) as FileResolutionResponse | { canUseBrowser?: false } | null
        mark('manifest')
        if (token !== runToken)
          return

        if (!res || (res as { canUseBrowser?: boolean }).canUseBrowser === false) {
          analyticsCtx.patchProgress(publicId, { stage: 'ready', filesAttached: 0, filesTotal: 0, endedAt: Date.now() })
          envelopes.value = { ...envelopes.value, [publicId]: null }
          progress.value = { completed: ++sitesReady, total: siteIds.length }
          return
        }

        const full = res as FileResolutionResponse
        const datesTable = full.tables.find(t => t.table === 'dates')
        const browserFiles = datesTable?.mode === 'browser' ? datesTable.files : []
        if (browserFiles.length === 0) {
          analyticsCtx.patchProgress(publicId, { stage: 'ready', filesAttached: 0, filesTotal: 0, endedAt: Date.now() })
          envelopes.value = { ...envelopes.value, [publicId]: null }
          progress.value = { completed: ++sitesReady, total: siteIds.length }
          return
        }

        analyticsCtx.patchProgress(publicId, { stage: 'wasm', filesAttached: 0, filesTotal: browserFiles.length })

        // ── wasm ────────────────────────────────────────────────────────
        // Wait for the shared boot. First site here pays the cost; others
        // hit the resolved promise instantly.
        if (!boot) {
          boot = await bootPromise
          if (token !== runToken)
            return
        }
        mark('wasm')
        const db = boot.db

        // Per-site connection so DDL+query run in parallel with other sites.
        // DuckDB-WASM supports multiple connections; each runs its statements
        // independently against the shared catalog/buffer pool.
        perSiteConn = await db.connect()

        analyticsCtx.patchProgress(publicId, { stage: 'attach' })

        const sanitised = sqlIdent(publicId)
        const viewName = `dates_${sanitised}`
        let filesAttached = 0

        opfsHandle = await attachParquetWithFallback({
          db,
          conn: perSiteConn,
          viewName,
          files: browserFiles,
          version: full.snapshotVersion,
          useOpfsCache,
          fetchConcurrency: browserFiles.length,
          onFileProgress: () => {
            filesAttached++
            analyticsCtx.patchProgress(publicId, { filesAttached })
          },
        })
        if (token !== runToken)
          return
        mark('attached')

        const result = await perSiteConn.query(`
          SELECT
            CAST(date AS VARCHAR) AS date,
            SUM(clicks)::DOUBLE AS clicks,
            SUM(impressions)::DOUBLE AS impressions,
            SUM(sum_position)::DOUBLE AS sum_position,
            AVG(anonymized_impressions_pct)::DOUBLE AS anonymized_impressions_pct
          FROM ${viewName}
          WHERE date >= DATE '${range.start}' AND date <= DATE '${range.end}'
          GROUP BY date
          ORDER BY date
        `)
        const rows = result.toArray() as unknown as DateRow[]
        if (token !== runToken)
          return

        // ── ready ───────────────────────────────────────────────────────
        // Materialise rows + publish the envelope. The home-page row for
        // this site renders here. Shallow-replace `envelopes` so Vue picks
        // up the change without resetting the whole map (other sites in
        // flight keep their null seats).
        const payload: DailyTotalRow[] = rows.map(r => ({
          date: Date.parse(`${r.date}T00:00:00Z`),
          clicks: Number(r.clicks),
          impressions: Number(r.impressions),
          sum_position: Number(r.sum_position),
          anonymizedImpressionsPct: Number(r.anonymized_impressions_pct) || 0,
        }))
        envelopes.value = {
          ...envelopes.value,
          [publicId]: payload.length > 0
            ? { version: 1, id: 'daily_totals', builtAt: Date.now(), windowDays: null, payload }
            : null,
        }
        analyticsCtx.patchProgress(publicId, { stage: 'ready', filesAttached: browserFiles.length, endedAt: Date.now() })
        progress.value = { completed: ++sitesReady, total: siteIds.length }
        mark('ready')
      }
      catch (err) {
        if (token !== runToken)
          return
        const msg = err instanceof Error ? err.message : String(err)
        analyticsCtx.patchProgress(publicId, { stage: 'error', error: msg, endedAt: Date.now() })
        // Surface the first per-site error on the composable's top-level
        // ref, but never trip the whole fanout — other sites keep loading.
        if (!error.value)
          error.value = err instanceof Error ? err : new Error(msg)
        progress.value = { completed: ++sitesReady, total: siteIds.length }

        console.error(`[useDailyTotalsFromIceberg] site ${publicId} failed after ${Date.now() - siteStart}ms`, err)
      }
      finally {
        if (opfsHandle)
          await opfsHandle.detach().catch(() => {})
        if (perSiteConn)
          await perSiteConn.close().catch(() => {})
      }
    }

    performance.mark('gsc:fanout:start')
    try {
      await Promise.all(siteIds.map(id => loadSite(id)))
    }
    finally {
      performance.mark('gsc:fanout:end')
      // DO NOT terminate — boot is shared via `sharedGscDuckDBWasm` and the
      // next refresh (or another consumer) reuses it. Per-site connections
      // and OPFS handles are closed in `loadSite`'s finally.
      if (token === runToken)
        loading.value = false
    }
  }

  watch(
    () => [(toValue(sites) ?? []).map(s => s.id).join(','), toValue(opts.range)?.start, toValue(opts.range)?.end],
    refresh,
    { immediate: true },
  )

  return {
    envelopes,
    loading: loading as Readonly<Ref<boolean>>,
    progress: progress as Readonly<Ref<{ completed: number, total: number }>>,
    error: error as Readonly<Ref<Error | null>>,
    refresh,
  }
}
