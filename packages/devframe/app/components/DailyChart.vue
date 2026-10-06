<script setup lang="ts">
// One metric's daily series against the previous window. One axis: the stat
// tiles pick the metric, so clicks and impressions never share a scale.

import type { DailyPoint } from '../../src/shared/protocol'
import type { Metric } from '../format'
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { formatDay, formatMetric, METRICS } from '../format'

const { daily, previousDaily, metric, windowLabel, previousLabel } = defineProps<{
  daily: DailyPoint[]
  previousDaily: DailyPoint[] | null
  metric: Metric
  windowLabel: string
  previousLabel: string
}>()

const HEIGHT = 168
const MARGIN = { top: 10, right: 12, bottom: 24, left: 44 }

const root = useTemplateRef<HTMLDivElement>('root')
const width = ref(480)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry)
      width.value = Math.max(240, Math.floor(entry.contentRect.width))
  })
  if (root.value)
    observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const label = computed(() => METRICS.find(m => m.key === metric)?.label ?? metric)
const current = computed(() => daily.map(point => point[metric]))
const previous = computed(() => previousDaily?.map(point => point[metric]) ?? null)
const inverted = computed(() => metric === 'position')

function niceStep(span: number): number {
  const raw = span / 3
  const power = 10 ** Math.floor(Math.log10(raw || 1))
  const scaled = raw / power
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power
}

const scale = computed(() => {
  const values = [...current.value, ...(previous.value ?? [])].filter((v): v is number => v != null)
  if (inverted.value) {
    // Position: 1 is the top of Google, so smaller numbers sit higher.
    const low = Math.max(1, Math.floor(Math.min(...values, 1)))
    const high = Math.max(low + 1, Math.ceil(Math.max(...values, low + 1)))
    const step = niceStep(high - low)
    const top = Math.max(1, Math.floor(low / step) * step)
    const bottom = Math.ceil(high / step) * step
    const ticks: number[] = []
    for (let tick = top; tick <= bottom + 1e-9; tick += step)
      ticks.push(tick)
    return { min: top, max: bottom, ticks }
  }
  const high = Math.max(...values, 0)
  const step = high > 0 ? niceStep(high) : 1
  const max = Math.max(step, Math.ceil(high / step) * step)
  const ticks: number[] = []
  for (let tick = 0; tick <= max + 1e-9; tick += step)
    ticks.push(tick)
  return { min: 0, max, ticks }
})

const plotWidth = computed(() => width.value - MARGIN.left - MARGIN.right)
const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
const stepX = computed(() => daily.length > 1 ? plotWidth.value / (daily.length - 1) : 0)

function x(index: number): number {
  return MARGIN.left + index * stepX.value
}

function y(value: number): number {
  const { min, max } = scale.value
  const ratio = max === min ? 0 : (value - min) / (max - min)
  return inverted.value ? MARGIN.top + ratio * plotHeight : MARGIN.top + (1 - ratio) * plotHeight
}

/** A day with no value (no impressions, so no position) breaks the line. */
function linePath(values: (number | null)[]): string {
  let path = ''
  let open = false
  values.forEach((value, index) => {
    if (value == null) {
      open = false
      return
    }
    path += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`
    open = true
  })
  return path
}

const currentPath = computed(() => linePath(current.value))
const previousPath = computed(() => previous.value ? linePath(previous.value) : '')
const areaPath = computed(() => {
  if (inverted.value || current.value.some(v => v == null) || daily.length < 2)
    return ''
  const base = y(scale.value.min)
  return `${linePath(current.value)}L${x(daily.length - 1).toFixed(1)},${base}L${x(0).toFixed(1)},${base}Z`
})

const xTicks = computed(() => {
  if (daily.length === 0)
    return []
  const indexes = daily.length > 2 ? [0, Math.floor((daily.length - 1) / 2), daily.length - 1] : [0, daily.length - 1]
  return [...new Set(indexes)].map(index => ({ index, label: formatDay(daily[index]!.date) }))
})

const hover = ref<number | null>(null)

function onPointer(event: PointerEvent): void {
  const rect = (event.currentTarget as SVGRectElement).getBoundingClientRect()
  const offset = event.clientX - rect.left
  hover.value = stepX.value > 0 ? Math.min(daily.length - 1, Math.max(0, Math.round(offset / stepX.value))) : 0
}

const tooltip = computed(() => {
  const index = hover.value
  if (index == null || !daily[index])
    return null
  const prev = previousDaily?.[index] ?? null
  const left = x(index)
  return {
    left,
    flip: left > width.value * 0.6,
    date: formatDay(daily[index].date, true),
    value: formatMetric(current.value[index] ?? null, metric),
    previousDate: prev ? formatDay(prev.date, true) : null,
    previousValue: prev ? formatMetric(previous.value?.[index] ?? null, metric) : null,
    currentY: current.value[index] == null ? null : y(current.value[index]!),
    previousY: previous.value?.[index] == null ? null : y(previous.value[index]!),
  }
})

const summary = computed(() => `${label.value} per day, ${windowLabel}. ${daily.length} days.`)
</script>

<template>
  <div ref="root" class="chart" :style="{ '--series': `var(--metric-${metric})` }">
    <div class="legend">
      <span class="item"><span class="key solid" aria-hidden="true" />{{ windowLabel }}</span>
      <span v-if="previousDaily" class="item"><span class="key dashed" aria-hidden="true" />{{ previousLabel }}</span>
      <span class="metric muted">{{ label }}</span>
    </div>
    <svg :width="width" :height="HEIGHT" role="img" :aria-label="summary">
      <g class="grid">
        <g v-for="tick in scale.ticks" :key="tick">
          <line :x1="MARGIN.left" :x2="width - MARGIN.right" :y1="y(tick)" :y2="y(tick)" />
          <text :x="MARGIN.left - 6" :y="y(tick)" text-anchor="end" dominant-baseline="middle" class="tabular">{{ formatMetric(tick, metric, 'compact') }}</text>
        </g>
        <text v-for="tick in xTicks" :key="tick.index" :x="x(tick.index)" :y="HEIGHT - 6" :text-anchor="tick.index === 0 ? 'start' : tick.index === daily.length - 1 ? 'end' : 'middle'">{{ tick.label }}</text>
      </g>
      <path v-if="areaPath" :d="areaPath" class="area" />
      <path v-if="previousPath" :d="previousPath" class="line previous" />
      <path :d="currentPath" class="line current" />
      <g v-if="tooltip">
        <line class="crosshair" :x1="tooltip.left" :x2="tooltip.left" :y1="MARGIN.top" :y2="MARGIN.top + plotHeight" />
        <circle v-if="tooltip.previousY != null" class="marker previous" :cx="tooltip.left" :cy="tooltip.previousY" r="4" />
        <circle v-if="tooltip.currentY != null" class="marker current" :cx="tooltip.left" :cy="tooltip.currentY" r="4" />
      </g>
      <rect
        class="hit"
        :x="MARGIN.left - stepX / 2"
        :y="MARGIN.top"
        :width="plotWidth + stepX"
        :height="plotHeight"
        @pointermove="onPointer"
        @pointerleave="hover = null"
      />
    </svg>
    <div v-if="tooltip" class="tooltip" :class="{ flip: tooltip.flip }" :style="{ left: `${tooltip.left}px` }" role="status">
      <div class="row">
        <span class="key solid" aria-hidden="true" /><span class="muted">{{ tooltip.date }}</span><strong class="tabular">{{ tooltip.value }}</strong>
      </div>
      <div v-if="tooltip.previousDate" class="row">
        <span class="key dashed" aria-hidden="true" /><span class="muted">{{ tooltip.previousDate }}</span><strong class="tabular">{{ tooltip.previousValue }}</strong>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
}

svg {
  display: block;
  overflow: visible;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  margin-bottom: 6px;
  font-size: 12px;
}

.legend .metric {
  margin-left: auto;
}

.item,
.row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.key {
  display: inline-block;
  width: 14px;
  height: 0;
  border-top: 2px solid var(--series);
}

.key.dashed {
  border-top-style: dashed;
  opacity: 0.55;
}

.grid line {
  stroke: var(--grid);
  stroke-width: 1;
}

.grid text {
  fill: var(--dimmed);
  font-size: 11px;
}

.line {
  fill: none;
  stroke: var(--series);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.line.previous {
  stroke-dasharray: 4 4;
  opacity: 0.55;
}

.area {
  fill: var(--series);
  opacity: 0.1;
}

.crosshair {
  stroke: var(--dimmed);
  stroke-width: 1;
}

.marker {
  fill: var(--series);
  stroke: var(--surface);
  stroke-width: 2;
}

.marker.previous {
  opacity: 0.55;
}

.hit {
  fill: transparent;
  cursor: crosshair;
}

.tooltip {
  position: absolute;
  top: 30px;
  transform: translateX(10px);
  display: grid;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
  font-size: 12px;
  pointer-events: none;
  white-space: nowrap;
}

.tooltip.flip {
  transform: translateX(calc(-100% - 10px));
}

.tooltip strong {
  margin-left: 8px;
}
</style>
