<script setup lang="ts">
// Fallback table for analyzers without a bespoke visualization. Renders
// every result row through the same auto-formatter that used to live in
// analyze.vue's `<section v-else>`: number/bigint formatting, JSON title
// attr for object cells, and Sparkline detection for `series`-shaped
// array columns.

const props = defineProps<{ rows: unknown[] }>()

const sortState = ref<{ column: string, direction: 'asc' | 'desc' } | null>(null)

const DISPLAY_KEYS = ['keyword', 'query', 'url', 'page', 'date', 'name', 'id', 'label', 'source', 'target']
const SERIES_METRIC_KEYS = ['observed', 'value', 'clicks', 'impressions', 'ctr', 'position', 'count', 'volatility', 'clicksLost']

function seriesValues(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 2)
    return null
  const first = v[0]
  if (first == null || typeof first !== 'object')
    return null
  const obj = first as Record<string, unknown>
  const metric = SERIES_METRIC_KEYS.find(k => typeof obj[k] === 'number')
  if (!metric)
    return null
  const out: number[] = []
  for (const item of v) {
    const n = (item as Record<string, unknown>)[metric]
    out.push(typeof n === 'number' && Number.isFinite(n) ? n : Number.NaN)
  }
  return out
}

function pickDisplayKey(obj: Record<string, unknown>): string | null {
  for (const k of DISPLAY_KEYS) {
    if (k in obj && (typeof obj[k] === 'string' || typeof obj[k] === 'number'))
      return k
  }
  return null
}

function fmtItem(v: unknown): string {
  if (v == null)
    return ''
  if (typeof v === 'bigint')
    return v.toLocaleString()
  if (typeof v === 'number')
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
  if (typeof v === 'string')
    return v
  if (typeof v === 'object') {
    const key = pickDisplayKey(v as Record<string, unknown>)
    if (key)
      return String((v as Record<string, unknown>)[key])
    return JSON.stringify(v)
  }
  return String(v)
}

function truncate(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function fmt(v: unknown): string {
  if (v == null)
    return ''
  if (typeof v === 'bigint')
    return v.toLocaleString()
  if (typeof v === 'number')
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
  if (Array.isArray(v)) {
    if (v.length === 0)
      return '[]'
    return truncate(`${v.length}× ${v.map(fmtItem).join(', ')}`)
  }
  if (typeof v === 'object')
    return truncate(JSON.stringify(v))
  return String(v)
}

function fmtTitle(v: unknown): string | undefined {
  if (Array.isArray(v) || (v !== null && typeof v === 'object'))
    return JSON.stringify(v, null, 2)
  return undefined
}

function isSortable(col: string): boolean {
  const sample = (props.rows[0] as Record<string, unknown> | undefined)?.[col]
  if (Array.isArray(sample) || (sample !== null && typeof sample === 'object'))
    return false
  return true
}

function toggleSort(col: string): void {
  if (!isSortable(col))
    return
  const cur = sortState.value
  if (cur && cur.column === col)
    sortState.value = { column: col, direction: cur.direction === 'desc' ? 'asc' : 'desc' }
  else
    sortState.value = { column: col, direction: 'desc' }
}

function compareCell(a: unknown, b: unknown): number {
  if (a == null && b == null)
    return 0
  if (a == null)
    return -1
  if (b == null)
    return 1
  if (typeof a === 'number' && typeof b === 'number')
    return a - b
  if (typeof a === 'bigint' && typeof b === 'bigint')
    return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' && typeof b === 'boolean')
    return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

const displayRows = computed<Record<string, unknown>[]>(() => {
  const arr = props.rows as Record<string, unknown>[]
  if (!sortState.value || !arr.length)
    return arr
  const key = sortState.value.column
  const dir = sortState.value.direction === 'desc' ? -1 : 1
  return [...arr].sort((ra, rb) => dir * compareCell(ra[key], rb[key]))
})

const columns = computed(() => {
  const row = displayRows.value[0]
  return row == null ? [] : Object.keys(row)
})
</script>

<template>
  <div class="gtap-wrap">
    <table>
      <thead>
        <tr>
          <th
            v-for="c in columns" :key="c"
            :class="{ sortable: isSortable(c), active: sortState?.column === c }"
            @click="toggleSort(c)"
          >
            {{ c }}
            <span v-if="sortState?.column === c && isSortable(c)" class="arrow">{{ sortState.direction === 'desc' ? '▼' : '▲' }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in displayRows" :key="i">
          <td v-for="c in columns" :key="c" :title="fmtTitle(row[c])" :class="{ num: typeof row[c] === 'number' || typeof row[c] === 'bigint' }">
            <Sparkline v-if="seriesValues(row[c])" :values="seriesValues(row[c])!" />
            <template v-else>
              {{ fmt(row[c]) }}
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.gtap-wrap { overflow-x: auto; max-height: 70vh; border: 1px solid var(--ui-border); border-radius: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th, td { padding: 0.45rem 0.85rem; border-bottom: 1px solid var(--ui-border); text-align: left; white-space: nowrap; }
th { background: var(--ui-bg-elevated); font-weight: 600; position: sticky; top: 0; font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ui-text-dimmed); user-select: none; }
th.sortable { cursor: pointer; }
th.sortable:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
th.active { color: var(--ui-text-highlighted); }
th .arrow { margin-left: 0.3em; font-size: 0.65rem; }
td.num { font-variant-numeric: tabular-nums; text-align: right; }
tbody tr:hover { background: var(--ui-bg-elevated); }
</style>
