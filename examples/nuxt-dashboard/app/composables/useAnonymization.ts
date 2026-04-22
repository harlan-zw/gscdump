// Reads the `daily_totals` rollup and derives the trailing-28-day average
// anonymizedImpressionsPct. Used to warn on query-grained tabs that ~half
// of impressions are stripped by GSC's per-query anonymization threshold,
// so sums of query-grained rows can't be trusted to match page totals.
//
// Best-effort: silently returns null if the rollup isn't available (first
// sync, dev without rollups wired) so the warning is never a hard error.

import type { RollupEnvelope } from '@gscdump/engine/rollups'

interface DailyTotalsRow {
  date: string
  clicks: number
  impressions: number
  anonymizedImpressionsPct: number
}

export interface AnonymizationState {
  trailingPct: Ref<number | null>
  windowDays: Ref<number>
  loading: Ref<boolean>
  error: Ref<Error | null>
  fetchMs: Ref<number | null>
}

const TRAILING_DAYS = 28
const NOT_FOUND_RE = /\b404\b/

let sharedFetch: Promise<{ pct: number | null, fetchMs: number }> | null = null

export function useAnonymization(): AnonymizationState {
  const trailingPct = ref<number | null>(null)
  const windowDays = ref(TRAILING_DAYS)
  const loading = ref(true)
  const error = ref<Error | null>(null)
  const fetchMs = ref<number | null>(null)

  onMounted(() => {
    if (!sharedFetch) {
      const t0 = performance.now()
      sharedFetch = $fetch<RollupEnvelope>('/api/rollup/daily_totals')
        .then((envelope) => {
          const elapsed = performance.now() - t0
          const rows = (envelope.payload ?? []) as DailyTotalsRow[]
          if (!Array.isArray(rows) || rows.length === 0)
            return { pct: null, fetchMs: elapsed }
          const recent = rows.slice(-TRAILING_DAYS)
          const weighted = recent.reduce(
            (acc, r) => {
              const imp = Number(r.impressions ?? 0)
              const pct = Number(r.anonymizedImpressionsPct ?? 0)
              return { impressions: acc.impressions + imp, weighted: acc.weighted + imp * pct }
            },
            { impressions: 0, weighted: 0 },
          )
          if (weighted.impressions === 0)
            return { pct: null, fetchMs: elapsed }
          return { pct: weighted.weighted / weighted.impressions, fetchMs: elapsed }
        })
        .catch((err: Error) => {
          const elapsed = performance.now() - t0
          // 404 on first boot before rollups are built is expected; don't
          // surface it as an error. Other failures do get surfaced.
          if (NOT_FOUND_RE.test(err.message))
            return { pct: null, fetchMs: elapsed }
          throw err
        })
    }
    sharedFetch
      .then(({ pct, fetchMs: ms }) => {
        trailingPct.value = pct
        fetchMs.value = ms
        loading.value = false
      })
      .catch((err: Error) => {
        error.value = err
        loading.value = false
      })
  })

  return { trailingPct, windowDays, loading, error, fetchMs }
}
