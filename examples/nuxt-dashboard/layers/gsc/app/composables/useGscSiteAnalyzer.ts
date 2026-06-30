// Type re-exports used directly by `examples/nuxt-dashboard`. The full
// runtime lives in nuxtseo.com.
// TODO: port from nuxtseo.com

import type { Ref } from 'vue'

export type GscFactTable
  = | 'pages'
    | 'queries'
    | 'countries'
    | 'dates'
    | 'page_queries'
    | 'search_appearance'
    | 'search_appearance_pages'
    | 'search_appearance_queries'
    | 'search_appearance_page_queries'

export type GscTableStage = 'idle' | 'resolving' | 'downloading' | 'attaching' | 'ready' | 'error' | 'unavailable'

export interface GscTableStatus {
  stage: GscTableStage
  filesAttached: number
  filesTotal: number
  startedAt?: number
  endedAt?: number
  error?: string
}

export interface UseGscSiteAnalyzerReturn {
  tables: Readonly<Ref<Record<GscFactTable, GscTableStatus>>>
  ready: Readonly<Ref<boolean>>
  error: Readonly<Ref<Error | null>>
  query: <T = Record<string, unknown>>(opts: {
    sql: string
    needs: readonly GscFactTable[]
    params?: readonly unknown[]
  }) => Promise<T[]>
  runQuery: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[], queryMs: number }>
  analyze: (params: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>
}

export function useGscSiteAnalyzer(
  _siteId?: unknown,
  _range?: unknown,
  _options?: { searchType?: string },
): UseGscSiteAnalyzerReturn {
  const tables = ref({} as Record<GscFactTable, GscTableStatus>)
  const ready = ref(false)
  const error = ref<Error | null>(null)
  return {
    tables: readonly(tables) as Readonly<Ref<Record<GscFactTable, GscTableStatus>>>,
    ready: readonly(ready),
    error: readonly(error) as Readonly<Ref<Error | null>>,
    query: async () => [],
    runQuery: async () => ({ rows: [], queryMs: 0 }),
    analyze: async () => ({}),
  }
}
