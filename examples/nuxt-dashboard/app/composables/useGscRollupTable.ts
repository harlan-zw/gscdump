// Top-N rollup table state for the dashboard's list pages.
//
// Owns the canonical wiring that the two rollup-backed list pages
// (queries/index, pages/index) previously duplicated:
//   - shared `useGscPeriod` + windowed range
//   - `useGscRollup` fetch
//   - URL-synced search/sort via `useGscTableState`
//   - debounced fuzzy filter on one row field
//   - position-aware sort (sort key 'position' invokes `positionFor`)
//   - top-N slice (default 100)
//
// Constraint on TRow: must include `impressions` and `sum_position` so
// `positionFor` works without a caller-supplied accessor.

import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue'

interface SortState { column: string, direction: 'asc' | 'desc' }

export interface UseGscRollupTableOptions<TRow> {
  siteId: MaybeRefOrGetter<string>
  rollupKey: string
  filterField: keyof TRow & string
  defaultSort?: SortState
  limit?: number
  debounceMs?: number
}

interface UseGscRollupTableReturn<TRow> {
  period: ReturnType<typeof useGscPeriod>['period']
  compareMode: ReturnType<typeof useGscPeriod>['compareMode']
  stableData: ReturnType<typeof useGscPeriod>['stableData']
  range: ReturnType<typeof useGscPeriod>['range']
  q: ReturnType<typeof useGscTableState>['q']
  sort: ReturnType<typeof useGscTableState>['sort']
  toggleSort: ReturnType<typeof useGscTableState>['toggleSort']
  payload: Ref<TRow[] | null>
  loading: Readonly<Ref<boolean>>
  rows: ComputedRef<TRow[]>
}

export function useGscRollupTable<
  TRow extends { impressions: number, sum_position: number },
>(opts: UseGscRollupTableOptions<TRow>): UseGscRollupTableReturn<TRow> {
  const { period, compareMode, stableData, range } = useGscPeriod({ shared: true })
  const windowRange = computed(() => ({ start: range.value.start, end: range.value.end }))

  const { data: payload, loading } = useGscRollup<TRow[]>(
    opts.siteId,
    opts.rollupKey,
    { range: windowRange },
  )

  const { q, sort, toggleSort } = useGscTableState({ defaultSort: opts.defaultSort })

  const searchDebounced = ref('')
  let handle: ReturnType<typeof setTimeout> | null = null
  watch(q, (v) => {
    if (handle)
      clearTimeout(handle)
    handle = setTimeout(() => {
      searchDebounced.value = v
    }, opts.debounceMs ?? 150)
  })

  const limit = opts.limit ?? 100
  const rows = computed<TRow[]>(() => {
    const needle = searchDebounced.value.trim().toLowerCase()
    const source = (payload.value ?? []).slice()
    const filtered = needle
      ? source.filter((r) => {
          const v = (r as Record<string, unknown>)[opts.filterField]
          return typeof v === 'string' && v.toLowerCase().includes(needle)
        })
      : source
    const s = sort.value
    if (s) {
      const dir = s.direction === 'desc' ? -1 : 1
      filtered.sort((a, b) => {
        const av = s.column === 'position' ? positionFor(a) : ((a as Record<string, unknown>)[s.column] as number)
        const bv = s.column === 'position' ? positionFor(b) : ((b as Record<string, unknown>)[s.column] as number)
        return av < bv ? -1 * dir : av > bv ? 1 * dir : 0
      })
    }
    return filtered.slice(0, limit)
  })

  return {
    period,
    compareMode,
    stableData,
    range,
    q,
    sort,
    toggleSort,
    payload: payload as Ref<TRow[] | null>,
    loading,
    rows,
  }
}
