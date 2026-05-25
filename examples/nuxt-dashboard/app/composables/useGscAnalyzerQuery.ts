import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { GscFactTable, GscTableStatus } from '@gscdump/nuxt/composables/useGscSiteAnalyzer'
import type { MaybeRefOrGetter } from 'vue'

export type DashboardFactTable = GscFactTable
export type DashboardTableStatus = GscTableStatus

export function useGscAnalyzerQuery(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  range: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>,
  options: { searchType?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews' } = {},
) {
  const analyzer = useGscSiteAnalyzer(siteId, range, {
    searchType: options.searchType ?? 'web',
  })

  async function query<T = Record<string, unknown>>(opts: { sql: string, needs?: readonly DashboardFactTable[], params?: readonly unknown[] }): Promise<T[]> {
    return analyzer.query<T>({
      sql: opts.sql,
      needs: opts.needs ?? [],
      params: opts.params,
    })
  }

  async function runQuery<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[], queryMs: number }> {
    return analyzer.runQuery<T>(sql, params)
  }

  return {
    tables: analyzer.tables,
    ready: analyzer.ready,
    error: analyzer.error,
    query,
    runQuery,
    analyze: analyzer.analyze as (params: AnalysisParams, opts?: { signal?: AbortSignal }) => Promise<AnalysisResult & { queryMs: number }>,
  }
}
