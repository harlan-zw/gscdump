// Reactive table state — search, pagination, sort, filter — with optional
// URL sync. One source of truth across a page so deep-links and
// back/forward navigation restore exactly what the user was looking at.

export interface GscSortState {
  column: string
  direction: 'asc' | 'desc'
}

export interface UseGscTableStateOptions<TFilter = Record<string, string>> {
  /** Sync state into the URL query string. Default `true`. */
  syncUrl?: boolean
  /** Prefix for query keys (avoids collisions when multiple tables share a page). */
  prefix?: string
  defaultPage?: number
  defaultPageSize?: number
  defaultQ?: string
  defaultSort?: GscSortState | null
  defaultFilter?: TFilter
}

export interface UseGscTableStateReturn<TFilter = Record<string, string>> {
  q: Ref<string>
  page: Ref<number>
  pageSize: Ref<number>
  sort: Ref<GscSortState | null>
  filter: Ref<TFilter>
  reset: () => void
  /** Toggle a column's sort: desc → asc → off. */
  toggleSort: (column: string) => void
}

export function useGscTableState<TFilter extends Record<string, any> = Record<string, string>>(
  opts: UseGscTableStateOptions<TFilter> = {},
): UseGscTableStateReturn<TFilter> {
  const syncUrl = opts.syncUrl ?? true
  const prefix = opts.prefix ?? ''
  const k = (name: string): string => (prefix ? `${prefix}_${name}` : name)

  const defaultPage = opts.defaultPage ?? 1
  const defaultPageSize = opts.defaultPageSize ?? 25
  const defaultQ = opts.defaultQ ?? ''
  const defaultSort = opts.defaultSort ?? null
  const defaultFilter = (opts.defaultFilter ?? {}) as TFilter

  const route = syncUrl ? useRoute() : null
  const router = syncUrl ? useRouter() : null

  function readQuery<T>(key: string, fallback: T, parse: (raw: string) => T): T {
    if (!route)
      return fallback
    const raw = route.query[k(key)]
    if (raw == null)
      return fallback
    return parse(Array.isArray(raw) ? (raw[0] ?? '') : String(raw))
  }

  function writeQuery(key: string, value: string | null): void {
    if (!route || !router)
      return
    const query = { ...route.query }
    const fullKey = k(key)
    if (value == null || value === '')
      delete query[fullKey]
    else
      query[fullKey] = value
    void router.replace({ query })
  }

  const q = ref(readQuery('q', defaultQ, s => s))
  const page = ref(readQuery('page', defaultPage, s => Number(s) || defaultPage))
  const pageSize = ref(readQuery('pageSize', defaultPageSize, s => Number(s) || defaultPageSize))
  const sort = ref<GscSortState | null>(readQuery('sort', defaultSort, parseSort))
  const filter = ref(defaultFilter) as Ref<TFilter>

  if (syncUrl) {
    watch(q, v => writeQuery('q', v || null))
    watch(page, v => writeQuery('page', v === defaultPage ? null : String(v)))
    watch(pageSize, v => writeQuery('pageSize', v === defaultPageSize ? null : String(v)))
    watch(sort, v => writeQuery('sort', serializeSort(v)))
  }

  // Reset page when q/filter changes (standard table UX).
  watch([q, filter], () => {
    page.value = defaultPage
  }, { deep: true })

  function reset(): void {
    q.value = defaultQ
    page.value = defaultPage
    pageSize.value = defaultPageSize
    sort.value = defaultSort
    filter.value = defaultFilter
  }

  function toggleSort(column: string): void {
    const cur = sort.value
    if (!cur || cur.column !== column) {
      sort.value = { column, direction: 'desc' }
      return
    }
    sort.value = cur.direction === 'desc' ? { column, direction: 'asc' } : null
  }

  return { q, page, pageSize, sort, filter, reset, toggleSort }
}

function serializeSort(s: GscSortState | null): string | null {
  return s ? `${s.column}:${s.direction}` : null
}

function parseSort(raw: string): GscSortState | null {
  if (!raw)
    return null
  const [column, direction] = raw.split(':')
  if (!column || (direction !== 'asc' && direction !== 'desc'))
    return null
  return { column, direction }
}
