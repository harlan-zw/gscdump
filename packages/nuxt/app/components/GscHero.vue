<script setup lang="ts">
// Hero block: four stat cards (clicks / impressions / CTR / avg position) with
// growth badges vs. the comparison window, plus a PerformanceChart over the
// selected period. Fed directly by the `daily_totals` rollup payload so it
// works before DuckDB has finished booting.
//
// Consumes `DateRange` from useGscPeriod — the caller owns period/compare state
// and passes the resolved window in. Keeping the compute here means the stat
// grid and chart read from the same windowed slice.

import type { CompareMode, DateRange } from '../composables/useGscPeriod'
import { computeGrowth } from '../composables/useGscPeriod'

interface DailyTotal {
  /** Rollup writer stamps this as Unix ms, not an ISO date. */
  date: number
  clicks: number
  impressions: number
  sum_position: number
  anonymizedImpressionsPct: number
}

const { payload, range, compareMode } = defineProps<{
  payload: readonly DailyTotal[] | null | undefined
  range: DateRange
  compareMode: CompareMode
}>()

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
}

function shiftIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10)
}

// Snap the requested window's `end` to the site's actual most-recent data
// point. Without this, a syncing site whose last day is earlier than the
// stable-latency cutoff compares a short-current window to a full-length
// previous window and shows a false decline.
function snapWindow(payload: readonly DailyTotal[], start: string, end: string): { start: string, end: string } {
  let maxIso: string | null = null
  for (const d of payload) {
    const iso = toIso(d.date)
    if (!maxIso || iso > maxIso)
      maxIso = iso
  }
  if (!maxIso || maxIso >= end)
    return { start, end }
  const shift = daysBetween(end, maxIso)
  return { start: shiftIso(start, shift), end: maxIso }
}

interface WindowTotals {
  clicks: number
  impressions: number
  ctr: number
  position: number
  series: Array<{ date: string, clicks: number, impressions: number }>
}

function summarize(days: readonly DailyTotal[], start: string, end: string): WindowTotals {
  let clicks = 0
  let impressions = 0
  let weightedPosition = 0
  const series: WindowTotals['series'] = []
  for (const d of days) {
    const iso = toIso(d.date)
    if (iso < start || iso > end)
      continue
    clicks += d.clicks
    impressions += d.impressions
    weightedPosition += d.sum_position
    series.push({ date: iso, clicks: d.clicks, impressions: d.impressions })
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions + 1 : 0,
    series,
  }
}

const stats = computed(() => {
  if (!payload?.length)
    return null
  const snapped = snapWindow(payload, range.start, range.end)
  const shift = daysBetween(range.end, snapped.end)
  const cmpRawStart = compareMode === 'year' ? range.yearStart : range.prevStart
  const cmpRawEnd = compareMode === 'year' ? range.yearEnd : range.prevEnd
  const cmpStart = shift ? shiftIso(cmpRawStart, shift) : cmpRawStart
  const cmpEnd = shift ? shiftIso(cmpRawEnd, shift) : cmpRawEnd
  return {
    current: summarize(payload, snapped.start, snapped.end),
    previous: compareMode === 'none' ? null : summarize(payload, cmpStart, cmpEnd),
    snapped,
  }
})

function fmtInt(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n))
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}
function fmtPos(n: number): string {
  return n > 0 ? n.toFixed(1) : '–'
}
function fmtGrowth(g: number | null, invert = false): string {
  if (g == null)
    return ''
  const v = invert ? -g : g
  const sign = v > 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(1)}%`
}
function growthColor(g: number | null, invert = false): 'success' | 'error' | 'neutral' {
  if (g == null || Math.abs(g) < 0.005)
    return 'neutral'
  const v = invert ? -g : g
  return v > 0 ? 'success' : 'error'
}

const statCards = computed(() => {
  if (!stats.value)
    return []
  const { current, previous } = stats.value
  return [
    {
      label: 'Clicks',
      value: fmtInt(current.clicks),
      icon: 'i-lucide-mouse-pointer-click',
      growth: computeGrowth(current.clicks, previous?.clicks),
      invert: false,
    },
    {
      label: 'Impressions',
      value: fmtInt(current.impressions),
      icon: 'i-lucide-eye',
      growth: computeGrowth(current.impressions, previous?.impressions),
      invert: false,
    },
    {
      label: 'CTR',
      value: fmtPct(current.ctr),
      icon: 'i-lucide-percent',
      growth: computeGrowth(current.ctr, previous?.ctr),
      invert: false,
    },
    {
      label: 'Avg. position',
      value: fmtPos(current.position),
      icon: 'i-lucide-hash',
      growth: computeGrowth(current.position, previous?.position),
      invert: true,
    },
  ]
})

const chartData = computed(() => stats.value?.current.series ?? [])
const chartPrevData = computed(() => stats.value?.previous?.series ?? [])
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div
        v-for="stat in statCards"
        :key="stat.label"
        class="rounded-lg border border-default bg-default p-4"
      >
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <UIcon :name="stat.icon" class="size-3" />
          {{ stat.label }}
        </div>
        <div class="flex items-baseline gap-2 mt-1.5">
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight">
            {{ stat.value }}
          </div>
          <UBadge
            v-if="stats?.previous"
            :color="growthColor(stat.growth, stat.invert)"
            variant="soft"
            size="xs"
            class="tabular-nums"
          >
            {{ fmtGrowth(stat.growth, stat.invert) }}
          </UBadge>
        </div>
      </div>
      <div
        v-if="!stats"
        class="col-span-full rounded-lg border border-dashed border-default p-6 text-center text-sm text-muted"
      >
        No data yet. Run <UKbd>gscdump sync</UKbd> to populate the daily_totals rollup.
      </div>
    </div>

    <div
      v-if="stats && chartData.length"
      class="rounded-lg border border-default bg-default p-4"
    >
      <GscPerformanceChart
        :value="chartData"
        :prev-value="compareMode !== 'none' ? chartPrevData : null"
        :height="220"
      />
    </div>
  </div>
</template>
