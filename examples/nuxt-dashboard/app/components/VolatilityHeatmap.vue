<script setup lang="ts">
// Calendar-style heatmap: rows = pages (top-N most volatile), cols = dates.
// Cell color = volatility (σ + |Δpos|) log-scaled against the window max.
// Hover shows per-day detail; clicking a row filters/details.

interface DayCell {
  date: string
  queryCount: number
  dayImpressions: number
  avgPosition: number
  posStddev: number
  bestPosition: number
  worstPosition: number
  dodShift: number
  volatility: number
}

interface PageRow {
  page: string
  avgVolatility: number
  peakVolatility: number
  totalImpressions: number
  days: DayCell[]
}

const props = defineProps<{
  pages: PageRow[]
  dates: string[]
  maxVolatility: number
}>()

const hovered = ref<{ page: string, day: DayCell } | null>(null)

const byPageByDate = computed(() => {
  const map = new Map<string, Map<string, DayCell>>()
  for (const p of props.pages) {
    const dm = new Map<string, DayCell>()
    for (const d of p.days) dm.set(d.date, d)
    map.set(p.page, dm)
  }
  return map
})

// Log-scale against the p95 of all cells to avoid a single outlier flattening
// the palette. Cheap O(n log n) percentile.
const p95 = computed(() => {
  const all: number[] = []
  for (const p of props.pages) {
    for (const d of p.days) all.push(d.volatility)
  }
  if (all.length === 0)
    return 1
  all.sort((a, b) => a - b)
  return all[Math.floor(all.length * 0.95)] || 1
})

function color(v: number | undefined): string {
  if (v == null || v === 0)
    return '#1a1b26'
  const t = Math.min(1, Math.log1p(v) / Math.log1p(p95.value))
  // Cyan → purple → red gradient
  const r = Math.round(40 + t * 215)
  const g = Math.round(60 - t * 40)
  const b = Math.round(140 - t * 60)
  return `rgb(${r}, ${Math.max(0, g)}, ${Math.max(40, b)})`
}

function shortDate(d: string): string {
  return d.slice(5) // MM-DD
}

const ORIGIN_RE = /^https?:\/\/[^/]+/

function shortUrl(u: string): string {
  const trimmed = u.replace(ORIGIN_RE, '')
  if (trimmed.length <= 30)
    return trimmed || '/'
  return `…${trimmed.slice(-28)}`
}

const dateLabelEvery = computed(() => {
  const n = props.dates.length
  if (n <= 20)
    return 1
  if (n <= 60)
    return 5
  return 14
})
</script>

<template>
  <div class="heat-wrap">
    <div class="heat-scroll">
      <table class="heat">
        <thead>
          <tr>
            <th class="sticky-col page-head">
              page
            </th>
            <th
              v-for="(d, i) in props.dates" :key="d"
              :class="{ 'date-major': i % dateLabelEvery === 0 }"
            >
              <span v-if="i % dateLabelEvery === 0">{{ shortDate(d) }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in props.pages" :key="p.page">
            <td class="sticky-col page-cell" :title="p.page">
              <div class="page-url">
                {{ shortUrl(p.page) }}
              </div>
              <div class="page-meta">
                μ={{ p.avgVolatility.toFixed(2) }} · max={{ p.peakVolatility.toFixed(2) }}
              </div>
            </td>
            <td
              v-for="d in props.dates" :key="d"
              class="cell"
              :style="{ background: color(byPageByDate.get(p.page)?.get(d)?.volatility) }"
              @mouseenter="hovered = byPageByDate.get(p.page)?.get(d) ? { page: p.page, day: byPageByDate.get(p.page)!.get(d)! } : null"
              @mouseleave="hovered = null"
            />
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="hovered" class="heat-tip">
      <div class="tip-head">
        <span class="tip-date">{{ hovered.day.date }}</span>
        <span class="tip-vol">vol {{ hovered.day.volatility.toFixed(2) }}</span>
      </div>
      <div class="tip-url">
        {{ hovered.page }}
      </div>
      <div class="tip-row">
        <span>avg position</span><b>{{ hovered.day.avgPosition.toFixed(2) }}</b>
      </div>
      <div class="tip-row">
        <span>σ positions</span><b>{{ hovered.day.posStddev.toFixed(2) }}</b>
      </div>
      <div class="tip-row">
        <span>best / worst</span><b>{{ hovered.day.bestPosition.toFixed(1) }} / {{ hovered.day.worstPosition.toFixed(1) }}</b>
      </div>
      <div class="tip-row">
        <span>DoD shift</span><b>{{ hovered.day.dodShift.toFixed(2) }}</b>
      </div>
      <div class="tip-row">
        <span>queries</span><b>{{ hovered.day.queryCount }}</b>
      </div>
    </div>
  </div>
</template>

<style scoped>
.heat-wrap { position: relative; background: #0c0d14; color: #e8e8f0; border-radius: 6px; overflow: hidden; }
.heat-scroll { overflow: auto; max-height: 70vh; }
.heat { border-collapse: collapse; font-size: 0.7rem; font-family: ui-monospace, monospace; }
.heat th { background: #13141e; color: #8b8ea5; font-weight: 500; padding: 0.25rem 0.2rem; position: sticky; top: 0; z-index: 2; white-space: nowrap; }
.heat th.date-major { color: #b9bccc; }
.heat td.cell { width: 14px; height: 20px; padding: 0; border: 1px solid #0c0d14; cursor: crosshair; }
.heat td.cell:hover { outline: 2px solid #fff; outline-offset: -1px; z-index: 3; position: relative; }
.sticky-col { position: sticky; left: 0; background: #13141e; z-index: 4; text-align: left; min-width: 220px; padding: 0.3rem 0.5rem; border-right: 1px solid #1d1f2e; }
.page-head { top: 0; z-index: 5; }
.page-cell .page-url { color: #e8e8f0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.page-cell .page-meta { color: #666980; font-size: 0.65rem; margin-top: 0.1rem; }
.heat-tip { position: absolute; top: 12px; right: 12px; background: rgba(20, 22, 34, 0.96); border: 1px solid #2a2d42; padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.72rem; min-width: 230px; backdrop-filter: blur(4px); pointer-events: none; }
.tip-head { display: flex; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.3rem; }
.tip-date { color: #9bb3ff; font-family: ui-monospace, monospace; }
.tip-vol { color: #ff9bb3; font-weight: 600; font-variant-numeric: tabular-nums; }
.tip-url { font-family: ui-monospace, monospace; color: #b9bccc; margin-bottom: 0.4rem; word-break: break-all; font-size: 0.68rem; }
.tip-row { display: flex; justify-content: space-between; gap: 1rem; margin: 0.12rem 0; color: #a0a0b5; font-variant-numeric: tabular-nums; }
.tip-row b { color: #e8e8f0; }
</style>
