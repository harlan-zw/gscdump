// Top-N rollup table state for list pages.
//
// Owns the canonical wiring previously duplicated across consumer apps:
//   - shared `useGscPeriod` + windowed range
//   - `useGscRollup` fetch
//   - URL-synced search/sort via `useGscTableState`
//   - debounced fuzzy filter on one row field
//   - position-aware sort (sort key 'position' invokes `positionFor`)
//   - top-N slice (default 100)
//
// Row shape contract: `impressions` + `sum_position` so `positionFor` works
// without a caller-supplied accessor.

import type { MaybeRefOrGetter, Ref } from '@vue/runtime-core'

interface SortState { column: string, direction: 'asc' | 'desc' }

export interface UseGscRollupTableOptions<TRow> {
  siteId: MaybeRefOrGetter<string>
  rollupKey: string
  filterField: keyof TRow & string
  defaultSort?: SortState
  limit?: number
  debounceMs?: number
}

export function useGscRollupTable<
  TRow extends { impressions: number, sum_position: number },
>(opts: UseGscRollupTableOptions<TRow>) {
  const { period, compareMode, stableData, range } = useGscPeriod()
  const windowRange = computed(() => ({ start: range.value.start, end: range.value.end }))

  const { data: payload, loading } = useGscRollup<TRow[]>(
    opts.siteId,
    opts.rollupKey,
    { range: windowRange },
  )

  const { q, sort, toggleSort } = useGscTableState({ defaultSort: opts.defaultSort })

  const searchDebounced = refDebounced<string>(q, opts.debounceMs ?? 150)

  const limit = opts.limit ?? 100
  const rows = computed<TRow[]>(() => {
    const needle = searchDebounced.value.trim().toLowerCase()
    const source = (payload.value ?? []).slice()
    const filtered = needle
      ? source.filter((r: TRow) => {
          const v = (r as Record<string, unknown>)[opts.filterField]
          return typeof v === 'string' && v.toLowerCase().includes(needle)
        })
      : source
    const s = sort.value
    if (s) {
      const dir = s.direction === 'desc' ? -1 : 1
      filtered.sort((a: TRow, b: TRow) => {
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
