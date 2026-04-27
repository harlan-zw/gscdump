<script lang="ts" setup>
// 4-metric overlay chart for GSC daily data. Ported from nuxtseo-pro's
// ProGraphGsc. Each metric lives in its own VisXYContainer stacked in the
// same grid cell so each uses the full chart height — Unovis's single
// container doesn't support independent y-domains per series.
//
// Key features:
//  - Optional previous-period comparison: prev rows are merged by calendar
//    date (prev.date + 1 year = current.date) and exposed via dashed lines.
//  - Calendar-aware tick planner: picks per-span tick count + format
//    ("Mon 12" / "Jan 12" / "Jan"+year) so x-axis labels don't crowd.
//  - Estimated-region overlay: dims the last GSC_STABLE_LATENCY_DAYS so
//    viewers don't mistake GSC's 3-day finalization lag for a real dip.
//  - Optional `fullValue` / `fullPrevValue` keep y-domains anchored to the
//    full period when the user zooms — scale doesn't jump per view.

import { Scale, TextAlign } from '@unovis/ts'
import { VisArea, VisAxis, VisCrosshair, VisLine, VisTooltip, VisXYContainer } from '@unovis/vue'
import { GSC_STABLE_LATENCY_DAYS } from '../utils/gsc-constants'

interface DataRow {
  date: string
  clicks: number
  impressions: number
  position?: number
  ctr?: number
}

const {
  value,
  prevValue = null,
  fullValue,
  fullPrevValue,
  columns = ['clicks', 'impressions'],
  height,
  loading: loadingProp = false,
} = defineProps<{
  value: DataRow[]
  prevValue?: DataRow[] | null
  /** Which metric layers to render. Default renders clicks + impressions. */
  columns?: string[]
  height?: number | string
  loading?: boolean
  /** Full (unzoomed) series — when provided, y-domains stay anchored to the full range. */
  fullValue?: DataRow[]
  fullPrevValue?: DataRow[] | null
}>()

const emit = defineEmits<{
  tooltip: [data: DataRow | null, prev: DataRow | null, isEstimated: boolean]
}>()

const loading = computed(() => loadingProp)

const gscColors = {
  clicks: { line: 'rgba(59, 130, 246, 0.9)', area: 'url(#gradient-clicks)', prev: 'rgba(59, 130, 246, 0.3)' },
  impressions: { line: 'rgba(168, 85, 247, 0.7)', area: 'url(#gradient-impressions)', prev: 'rgba(168, 85, 247, 0.3)' },
  ctr: { line: 'rgba(34, 197, 94, 0.9)', prev: 'rgba(34, 197, 94, 0.3)' },
  position: { line: 'rgba(251, 146, 60, 0.9)', prev: 'rgba(251, 146, 60, 0.3)' },
}

const margin = { left: 0, right: 0, top: 0, bottom: 36 }
const chartHeight = computed(() => Number(height) || 220)
const chartInnerHeight = computed(() => chartHeight.value - margin.top - margin.bottom)

const svgDefs = `
  <linearGradient id="gradient-clicks" gradientTransform="rotate(90)">
    <stop offset="0%" stop-color="rgba(59, 130, 246, 0.25)" />
    <stop offset="100%" stop-color="rgba(59, 130, 246, 0.01)" />
  </linearGradient>
  <linearGradient id="gradient-impressions" gradientTransform="rotate(90)">
    <stop offset="0%" stop-color="rgba(168, 85, 247, 0.2)" />
    <stop offset="100%" stop-color="rgba(168, 85, 247, 0.01)" />
  </linearGradient>`

type MergedRow = DataRow & { prev?: DataRow }
const mergedValue = computed<MergedRow[]>(() => {
  if (!value.length)
    return []
  if (!prevValue?.length)
    return value.slice()
  const prevByDate = new Map<string, DataRow>()
  for (const row of prevValue) prevByDate.set(row.date, row)
  return value.map((row) => {
    const [y, m, d] = row.date.split('-')
    const key = `${Number(y) - 1}-${m}-${d}`
    const match = prevByDate.get(key)
    return match ? { ...row, prev: match } : row
  })
})

const hasComparison = computed(() => mergedValue.value.some(r => r.prev))

// NaN y-values break the cubic curve (d3-shape's default `defined` skips them),
// so the dashed line only renders across indices with matching prev data.
const prevClicks = (d: MergedRow) => d.prev?.clicks ?? Number.NaN
const prevImpressions = (d: MergedRow) => d.prev?.impressions ?? Number.NaN
const prevCtr = (d: MergedRow) => d.prev?.ctr != null ? d.prev.ctr * 100 : Number.NaN
const prevPosition = (d: MergedRow) => d.prev?.position ?? Number.NaN

interface TickPlan {
  indices: number[]
  format: (date: Date, i: number, firstYear: number) => string
}

const weekdayDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })
const monthDayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' })
const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' })

const tickPlan = computed<TickPlan>(() => {
  const len = value.length
  if (len <= 1)
    return { indices: [0], format: d => monthDayFmt.format(d) }

  if (len <= 10)
    return { indices: value.map((_, i) => i), format: d => weekdayDayFmt.format(d) }

  if (len <= 35) {
    const step = Math.max(1, Math.ceil(len / 5))
    const indices: number[] = []
    for (let i = 0; i < len; i += step) indices.push(i)
    if (indices[indices.length - 1] !== len - 1)
      indices.push(len - 1)
    return { indices, format: d => monthDayFmt.format(d) }
  }

  if (len <= 120) {
    const step = 14
    const indices: number[] = []
    for (let i = 0; i < len; i += step) indices.push(i)
    return { indices, format: d => monthDayFmt.format(d) }
  }

  // Long span: first-of-month ticks.
  const indices: number[] = []
  let lastMonth = ''
  for (let i = 0; i < len; i++) {
    const m = value[i]?.date.slice(0, 7)
    if (!m)
      continue
    if (m !== lastMonth) {
      indices.push(i)
      lastMonth = m
    }
  }
  if (indices.length < 2)
    return { indices: [0, Math.floor(len / 2), len - 1], format: d => monthDayFmt.format(d) }

  if (indices.length > 14) {
    const keep = Math.ceil(indices.length / 12)
    const thinned = indices.filter((_, i) => i % keep === 0)
    return {
      indices: thinned,
      format: (d, i, firstYear) => (d.getMonth() === 0 || i === 0) && d.getFullYear() !== firstYear
        ? monthYearFmt.format(d)
        : monthFmt.format(d),
    }
  }
  return {
    indices,
    format: (d, i, _firstYear) => (d.getMonth() === 0 && i > 0) || (i === 0 && d.getMonth() !== 0 && indices.length > 6)
      ? monthYearFmt.format(d)
      : monthFmt.format(d),
  }
})

const firstTickYear = computed(() => {
  const first = tickPlan.value.indices[0]
  const row = first == null ? undefined : value[first]
  if (!row?.date)
    return new Date().getFullYear()
  return Number(row.date.slice(0, 4))
})

function tickFormat(d: number) {
  const idx = Math.round(d)
  if (idx < 0 || idx >= value.length)
    return ''
  const row = value[idx]
  if (!row?.date)
    return ''
  const tickIdx = tickPlan.value.indices.indexOf(idx)
  return tickPlan.value.format(new Date(row.date), tickIdx, firstTickYear.value)
}

// Unstable region: compare YYYY-MM-DD strings directly — avoid Date round-trips
// that shift across timezones (AEST → UTC can drop the date back a day).
const unstableCutoffDate = computed(() => {
  const pstStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
  const parts = pstStr.split('-').map(Number)
  const y = parts[0] ?? new Date().getFullYear()
  const m = parts[1] ?? 1
  const d = parts[2] ?? 1
  const cutoff = new Date(y, m - 1, d - GSC_STABLE_LATENCY_DAYS)
  return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
})

const unstableCount = computed(() => {
  if (!value.length)
    return 0
  const cutoff = unstableCutoffDate.value
  let count = 0
  for (let i = value.length - 1; i >= 0; i--) {
    const row = value[i]
    if (row && row.date > cutoff)
      count++
    else break
  }
  return count
})

const unstableWidthPct = computed(() => {
  if (!unstableCount.value || value.length < 2)
    return 0
  return (unstableCount.value - 0.5) / (value.length - 1) * 100
})

function crosshairTemplate(d: DataRow) {
  const idx = mergedValue.value.findIndex(r => r.date === d.date)
  const prev = idx >= 0 ? (mergedValue.value[idx]?.prev ?? null) : null
  const isEstimated = unstableCount.value > 0 && idx >= mergedValue.value.length - unstableCount.value
  nextTick(() => emit('tooltip', d, prev, isEstimated))
  return ''
}

function handleMouseLeave() {
  emit('tooltip', null, null, false)
}

const allData = computed(() => {
  const cur = fullValue ?? value
  const prev = fullPrevValue !== undefined ? fullPrevValue : prevValue
  return [...cur, ...(prev || [])]
})

const clicksDomain = computed<[number, number]>(() => {
  if (!allData.value.length)
    return [0, 1]
  const max = Math.max(...allData.value.map(d => d.clicks), 1)
  return [0, max * 1.1]
})

const impressionsDomain = computed<[number, number]>(() => {
  if (!allData.value.length)
    return [0, 1]
  const max = Math.max(...allData.value.map(d => d.impressions), 1)
  return [0, max * 1.1]
})

const ctrScale = computed(() => {
  const ctrs = allData.value.map(d => (d.ctr ?? 0) * 100).filter(c => c > 0)
  const min = ctrs.length ? Math.min(...ctrs) : 0
  const max = ctrs.length ? Math.max(...ctrs) : 10
  const padding = (max - min) * 0.1 || 1
  return Scale.scaleLinear()
    .domain([Math.max(0, min - padding), max + padding])
    .range([0, chartInnerHeight.value])
})

// Position scale inverted: lower GSC position (better rank) = higher on chart.
const positionScale = computed(() => {
  const positions = allData.value.map(d => d.position ?? 0).filter(p => p > 0)
  const min = positions.length ? Math.min(...positions) : 1
  const max = positions.length ? Math.max(...positions) : 100
  const padding = (max - min) * 0.1 || 1
  return Scale.scaleLinear()
    .domain([Math.max(1, min - padding), max + padding])
    .range([chartInnerHeight.value, 0])
})

// Force re-mount all containers when data shape changes — Unovis doesn't
// always rescale cleanly on same-length but different-range transitions.
const chartKey = computed(() => {
  const len = value.length
  const first = value[0]?.date ?? ''
  const last = value[len - 1]?.date ?? ''
  return `${len}-${first}-${last}`
})

const x = (_d: DataRow, i: number) => i
const clicks = (d: DataRow) => d.clicks
const impressions = (d: DataRow) => d.impressions
const ctr = (d: DataRow) => (d.ctr ?? 0) * 100
const position = (d: DataRow) => d.position ?? 0
</script>

<template>
  <div
    data-ui="GscPerformanceChart"
    class="gsc-chart"
    role="img"
    aria-label="Search Console performance chart"
    :style="{ height: `${chartHeight}px` }"
    @mouseleave="handleMouseLeave"
  >
    <div v-if="loading" class="loading-skeleton">
      <div class="flex-1 flex items-end gap-1">
        <div v-for="i in 30" :key="i" class="flex-1 h-full flex">
          <UiSkeleton type="bar" :index="i" />
        </div>
      </div>
      <div class="flex justify-between mt-3">
        <UiSkeleton v-for="i in 5" :key="i" class="h-3 w-12" />
      </div>
    </div>

    <div v-else-if="value.length < 2" class="flex flex-col items-center justify-center h-full text-center gap-1">
      <p class="text-sm text-muted">
        {{ value.length === 0 ? 'No data for this period' : 'Only 1 day of data so far' }}
      </p>
      <p v-if="value.length === 1" class="text-xs text-dimmed">
        The chart will appear once more days are available
      </p>
    </div>

    <ClientOnly v-else>
      <div
        v-if="unstableWidthPct > 0"
        class="estimated-region"
        :style="{ width: `${unstableWidthPct}%`, bottom: `${margin.bottom}px` }"
      >
        <div class="estimated-tint" />
        <div class="estimated-separator" />
      </div>

      <VisXYContainer
        v-if="columns.includes('impressions')"
        :key="`impressions-${chartKey}`"
        :height="chartHeight"
        :data="mergedValue"
        :svg-defs="svgDefs"
        :margin="margin"
        :auto-margin="false"
        class="chart-layer"
        :y-domain="impressionsDomain"
      >
        <VisLine
          v-if="hasComparison"
          curve-type="monotoneX"
          :x="x"
          :y="prevImpressions"
          :color="gscColors.impressions.prev"
          :line-width="1.5"
          :line-dash-array="[6, 4]"
        />
        <VisArea :color="gscColors.impressions.area" curve-type="monotoneX" :x="x" :y="impressions" />
        <VisLine curve-type="monotoneX" :x="x" :y="impressions" :color="gscColors.impressions.line" :line-width="2" />
      </VisXYContainer>

      <VisXYContainer
        v-if="columns.includes('clicks')"
        :key="`clicks-${chartKey}`"
        :height="chartHeight"
        :data="mergedValue"
        :svg-defs="svgDefs"
        :margin="margin"
        :auto-margin="false"
        class="chart-layer"
        :y-domain="clicksDomain"
      >
        <VisLine
          v-if="hasComparison"
          curve-type="monotoneX"
          :x="x"
          :y="prevClicks"
          :color="gscColors.clicks.prev"
          :line-width="1.5"
          :line-dash-array="[6, 4]"
        />
        <VisArea :color="gscColors.clicks.area" curve-type="monotoneX" :x="x" :y="clicks" />
        <VisLine curve-type="monotoneX" :x="x" :y="clicks" :color="gscColors.clicks.line" :line-width="2" />
      </VisXYContainer>

      <VisXYContainer
        v-if="columns.includes('ctr')"
        :key="`ctr-${chartKey}`"
        :height="chartHeight"
        :data="mergedValue"
        :margin="margin"
        :auto-margin="false"
        class="chart-layer"
      >
        <VisLine
          v-if="hasComparison"
          curve-type="monotoneX"
          :x="x"
          :y="prevCtr"
          :y-scale="ctrScale"
          :color="gscColors.ctr.prev"
          :line-width="1.5"
          :line-dash-array="[6, 4]"
        />
        <VisLine curve-type="monotoneX" :x="x" :y="ctr" :y-scale="ctrScale" :color="gscColors.ctr.line" :line-width="2" />
      </VisXYContainer>

      <VisXYContainer
        v-if="columns.includes('position')"
        :key="`position-${chartKey}`"
        :height="chartHeight"
        :data="mergedValue"
        :margin="margin"
        :auto-margin="false"
        class="chart-layer"
      >
        <VisLine
          v-if="hasComparison"
          curve-type="monotoneX"
          :x="x"
          :y="prevPosition"
          :y-scale="positionScale"
          :color="gscColors.position.prev"
          :line-width="1.5"
          :line-dash-array="[6, 4]"
        />
        <VisLine curve-type="monotoneX" :x="x" :y="position" :y-scale="positionScale" :color="gscColors.position.line" :line-width="2" />
      </VisXYContainer>

      <VisXYContainer
        :key="`interactive-${chartKey}`"
        :height="chartHeight"
        :data="mergedValue"
        :margin="margin"
        :auto-margin="false"
        class="chart-layer chart-layer--interactive"
      >
        <VisLine :x="x" :y="clicks" color="transparent" :line-width="0" />
        <VisAxis
          type="x"
          :tick-line="false"
          :grid-line="false"
          :domain-line="false"
          :tick-values="tickPlan.indices"
          :tick-format="tickFormat"
          :tick-text-align="TextAlign.Left"
          tick-text-font-size="11px"
          tick-text-color="var(--ui-text-dimmed)"
        />
        <VisTooltip :follow-cursor="false" horizontal-placement="right" />
        <VisCrosshair color="none" :template="crosshairTemplate" />
      </VisXYContainer>

      <template #fallback>
        <div class="loading-skeleton">
          <div class="flex-1 flex items-end gap-1">
            <div v-for="i in 30" :key="i" class="flex-1">
              <UiSkeleton type="bar" :index="i" />
            </div>
          </div>
          <div class="flex justify-between mt-3">
            <UiSkeleton v-for="i in 5" :key="i" class="h-3 w-12" />
          </div>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>

<style scoped>
[data-ui="GscPerformanceChart"] :deep(.unovis-area-group path) {
  stroke: none;
}

.gsc-chart {
  display: grid;
  grid-template-columns: 1fr;
  position: relative;
}

.gsc-chart .chart-layer,
.gsc-chart .loading-skeleton {
  grid-column-start: 1;
  grid-row-start: 1;
}

.gsc-chart .chart-layer {
  pointer-events: none;
}

.gsc-chart .chart-layer--interactive {
  pointer-events: auto;
  --vis-crosshair-line-stroke-color: var(--ui-border-accented);
  --vis-crosshair-line-stroke-opacity: 0.6;
}

.gsc-chart .chart-layer--interactive :deep(.unovis-tooltip) {
  display: none;
}

.estimated-region {
  position: absolute;
  top: 0;
  right: 0;
  pointer-events: none;
  z-index: 5;
}

.estimated-tint {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--ui-bg) 60%, transparent) 40%
  );
}

.estimated-separator {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background: repeating-linear-gradient(
    to bottom,
    var(--ui-text-dimmed) 0,
    var(--ui-text-dimmed) 3px,
    transparent 3px,
    transparent 7px
  );
  opacity: 0.35;
}

.loading-skeleton {
  display: flex;
  flex-direction: column;
  justify-content: end;
  padding-bottom: 2rem;
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
</style>
