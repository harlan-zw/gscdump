// Adapter exposing `useGscSiteAnalyzer` under the legacy `useGscAnalyzer`
// contract. Lets pages that depend on the analyzer-registry composables
// (`useGscAnalyzerDefs`, `useGscAnalyzerBatch`, `<GscAnalyzerPanel>`) reuse
// the per-site DuckDB-WASM boot already established by overview / queries /
// pages / countries instead of booting their own runtime.
//
// `query(sql, params?)` extracts referenced fact tables from the SQL and
// passes them as `needs` so on-demand attach still works. `analyze(params)`
// builds an `attached-table` source whose `executeSql` proxies back to the
// same `query`, then runs the requested analyzer through the default
// registry. No schema-prefix rewriting on top of what the engine already
// emits — views land in `main.<table>` and the analyzer SQL targets exactly
// that.

import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'
import type { GscAnalyzerInstance, GscFactTable } from '@gscdump/nuxt'
import type { MaybeRefOrGetter, Ref } from '@vue/runtime-core'
import { defaultAnalyzerRegistry } from '@gscdump/analysis'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createAttachedTableSource } from '@gscdump/engine/source'

const ALL_TABLES: readonly GscFactTable[] = ['pages', 'queries', 'countries', 'dates', 'page_queries']
const FACT_TABLE_NAMES = ALL_TABLES.join('|')
const TABLE_RE = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:main\\.)?(${FACT_TABLE_NAMES})\\b`, 'gi')

function tablesFromSql(sql: string): GscFactTable[] {
  const out = new Set<GscFactTable>()
  for (const m of sql.matchAll(TABLE_RE))
    out.add(m[1]!.toLowerCase() as GscFactTable)
  return out.size > 0 ? Array.from(out) : [...ALL_TABLES]
}

export function useGscSiteAnalyzerLegacy(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  range: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>,
): GscAnalyzerInstance {
  const site = useGscSiteAnalyzer(siteId, range)

  async function query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[], queryMs: number }> {
    const t0 = performance.now()
    const rows = await site.query<Record<string, unknown>>({
      sql,
      needs: tablesFromSql(sql),
      params,
    })
    return { rows, queryMs: performance.now() - t0 }
  }

  async function analyze(params: AnalysisParams, opts?: { signal?: AbortSignal }): Promise<AnalysisResult & { queryMs: number }> {
    const t0 = performance.now()
    const source = createAttachedTableSource(
      {
        query: async (sql, bindParams) => {
          const rows = await site.query<Record<string, unknown>>({
            sql,
            needs: tablesFromSql(sql),
            params: bindParams,
          })
          return rows
        },
      },
      {
        schema: 'main',
        signal: opts?.signal,
        attachedTables: ALL_TABLES as readonly string[],
      },
    )
    const result = await runAnalyzerFromSource(source, params, defaultAnalyzerRegistry)
    return {
      results: result.results as AnalysisResult['results'],
      meta: result.meta as AnalysisResult['meta'],
      queryMs: performance.now() - t0,
    }
  }

  const initializing = computed(() => !site.ready.value && site.error.value == null)
  const attachedTables = computed(() => [...ALL_TABLES])
  const timings = computed(() => site.ready.value ? { bootMs: 0, manifestMs: 0, attachMs: 0 } : null)
  const manifestVersion = ref<string | undefined>(undefined)

  return {
    ready: site.ready as Ref<boolean>,
    initializing: initializing as unknown as Ref<boolean>,
    error: site.error as Ref<Error | null>,
    attachedTables: attachedTables as unknown as Ref<string[]>,
    timings: timings as unknown as Ref<GscAnalyzerInstance['timings']['value']>,
    manifestVersion,
    query,
    analyze,
    refresh: async () => false,
    dispose: async () => {},
  }
}
