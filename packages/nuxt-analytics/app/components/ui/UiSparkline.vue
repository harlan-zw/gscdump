<script setup lang="ts">
type Datum = Record<string, number | string>

interface Props {
  data: number[] | Datum[]
  /** Previous period data, when provided, gradient reflects per-point changes */
  previousData?: number[] | Datum[]
  xAxis?: string
  yAxis?: string
  width?: number | string
  height?: number | string
  size?: 'sm' | 'md' | 'lg'
  /** Single color or named color (blue, green, purple, orange, red, neutral) */
  color?: string
  /** Full gradient color array, overrides color & trend defaults */
  colors?: string[]
  /** Colors for comparison mode [improved, declined, neutral] */
  comparisonColors?: [string, string, string]
  strokeWidth?: number
  /** Max data points to render, larger datasets are downsampled via LTTB */
  maxPoints?: number
  /** SVG preserveAspectRatio, set to "none" to stretch fill */
  preserveAspectRatio?: string
  /** Render style. 'line' (smooth curve), 'bars' (vertical bars for discrete counts), 'step' (stepped line for slow integer-valued metrics like DA) */
  variant?: 'line' | 'bars' | 'step'
}

const {
  data,
  previousData,
  yAxis,
  width,
  height,
  size = 'md',
  color,
  colors,
  comparisonColors = ['#057a55', '#dc2626', '#6b7280'],
  strokeWidth = 1.5,
  maxPoints = 80,
  preserveAspectRatio,
  variant = 'line',
} = defineProps<Props>()

const namedColors: Record<string, string> = {
  blue: '#3b82f6',
  green: '#22c55e',
  purple: '#a855f7',
  orange: '#f97316',
  red: '#ef4444',
  neutral: '#6b7280',
}

function resolveColor(c: string): string {
  return namedColors[c] || c
}

const sizeDefaults: Record<string, { w: number, h: number }> = {
  sm: { w: 96, h: 24 },
  md: { w: 120, h: 32 },
  lg: { w: 160, h: 36 },
}

// Size fallback when `size` isn't one of the named presets. `md` is the
// documented default; using `!` on the indexed lookup here keeps the
// compiler from flagging every downstream read as possibly-undefined.
const defaults = computed(() => sizeDefaults[size] ?? sizeDefaults.md!)

// CSS width/height — can be string like "100%" or number
const cssWidth = computed(() => width ?? defaults.value.w)
const cssHeight = computed(() => height ?? defaults.value.h)

// Internal numeric dimensions for viewBox/path calculations
const vbW = computed(() => typeof cssWidth.value === 'number' ? cssWidth.value : defaults.value.w)
const vbH = computed(() => typeof cssHeight.value === 'number' ? cssHeight.value : defaults.value.h)

function normalize(input: number[] | Datum[] | undefined, yAxis?: string): number[] {
  if (!input?.length)
    return []
  if (typeof input[0] === 'number')
    return input as number[]
  const data = input as Datum[]
  const yKey = yAxis || guessYKey(data[0]!)
  return data.map(d => Number(d[yKey]) || 0)
}

function guessYKey(d: Datum): string {
  for (const key of ['y', 'value', 'clicks', 'impressions', 'count']) {
    if (key in d)
      return key
  }
  const skip = new Set(['x', 'index', 'timestamp', 'date'])
  for (const key of Object.keys(d)) {
    if (!skip.has(key) && typeof d[key] === 'number')
      return key
  }
  return Object.keys(d)[1] ?? Object.keys(d)[0] ?? 'value'
}

/**
 * Largest Triangle Three Buckets — downsamples while preserving visual shape.
 * Keeps first and last points, selects most visually significant point per bucket.
 */
function lttb(vals: number[], target: number): number[] {
  if (vals.length <= target)
    return vals

  const result: number[] = [vals[0]!]
  const bucketSize = (vals.length - 2) / (target - 2)

  let prevIndex = 0
  for (let i = 1; i < target - 1; i++) {
    const bucketStart = Math.floor((i - 1) * bucketSize) + 1
    const bucketEnd = Math.min(Math.floor(i * bucketSize) + 1, vals.length - 1)

    // Average of next bucket (for triangle area calc)
    const nextStart = Math.floor(i * bucketSize) + 1
    const nextEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, vals.length - 1)
    let avgX = 0
    let avgY = 0
    const nextLen = nextEnd - nextStart + 1
    for (let j = nextStart; j <= nextEnd; j++) {
      avgX += j
      avgY += vals[j]!
    }
    avgX /= nextLen
    avgY /= nextLen

    // Pick point in current bucket with largest triangle area
    let maxArea = -1
    let bestIndex = bucketStart
    const px = prevIndex
    const py = vals[prevIndex]!
    for (let j = bucketStart; j <= bucketEnd; j++) {
      const area = Math.abs((px - avgX) * (vals[j]! - py) - (px - j) * (avgY - py))
      if (area > maxArea) {
        maxArea = area
        bestIndex = j
      }
    }

    result.push(vals[bestIndex]!)
    prevIndex = bestIndex
  }

  result.push(vals.at(-1)!)
  return result
}

const values = computed(() => lttb(normalize(data, yAxis), maxPoints))
const prevValues = computed(() => lttb(normalize(previousData, yAxis), maxPoints))
const hasComparison = computed(() => prevValues.value.length > 0)

const trend = computed<-1 | 0 | 1>(() => {
  if (values.value.length < 2)
    return 0
  const first = values.value[0]!
  const last = values.value.at(-1)!
  return last > first ? 1 : last < first ? -1 : 0
})

// Per-point comparison colors: at each data point, compare current vs previous
const comparisonGradientColors = computed<string[]>(() => {
  const curr = values.value
  const prev = prevValues.value
  if (!prev.length)
    return []

  const [up, down, flat] = comparisonColors
  return curr.map((v, i) => {
    const p = prev[i] ?? prev.at(-1) ?? 0
    if (v > p)
      return up
    if (v < p)
      return down
    return flat
  })
})

const gradientColors = computed(() => {
  if (hasComparison.value && comparisonGradientColors.value.length >= 2)
    return comparisonGradientColors.value

  if (colors)
    return colors.map(resolveColor)
  if (color) {
    const resolved = resolveColor(color)
    return ['#94a3b8', resolved]
  }
  if (trend.value === 1)
    return ['#94a3b8', '#057a55']
  if (trend.value === -1)
    return ['#94a3b8', '#dc2626']
  return ['#94a3b8', '#6b7280']
})

// Build gradient stops for SVG linearGradient (evenly spaced)
const gradientStops = computed(() => {
  const colors = gradientColors.value
  if (colors.length <= 1)
    return [{ offset: '0%', color: colors[0] || '#6b7280' }, { offset: '100%', color: colors[0] || '#6b7280' }]
  return colors.map((color, i) => ({
    offset: `${(i / (colors.length - 1)) * 100}%`,
    color,
  }))
})

function projectPoints(vals: number[]) {
  const padX = strokeWidth
  const padY = strokeWidth
  const chartW = vbW.value - padX * 2
  const chartH = vbH.value - padY * 2

  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1

  return {
    padX,
    padY,
    chartW,
    chartH,
    points: vals.map((v, i) => ({
      x: padX + (i / (vals.length - 1)) * chartW,
      y: padY + chartH - ((v - min) / range) * chartH,
    })),
  }
}

function buildPath(vals: number[]): string {
  if (vals.length < 2)
    return ''

  const { points } = projectPoints(vals)

  const segments: string[] = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[Math.min(i + 2, points.length - 1)]!

    const tension = 0.3
    const cp1x = p1.x + (p2.x - p0.x) * tension
    const cp1y = p1.y + (p2.y - p0.y) * tension
    const cp2x = p2.x - (p3.x - p1.x) * tension
    const cp2y = p2.y - (p3.y - p1.y) * tension

    segments.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`)
  }

  return segments.join(' ')
}

function buildStepPath(vals: number[]): string {
  if (vals.length < 2)
    return ''
  const { points } = projectPoints(vals)
  const segments: string[] = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!
    const prev = points[i - 1]!
    segments.push(`L ${p.x} ${prev.y}`, `L ${p.x} ${p.y}`)
  }
  return segments.join(' ')
}

interface BarRect { x: number, y: number, w: number, h: number }
function buildBars(vals: number[]): BarRect[] {
  if (!vals.length)
    return []
  const { padY, chartW, chartH, points } = projectPoints(vals)
  const gapRatio = 0.3
  const slotW = chartW / vals.length
  const barW = Math.max(1, slotW * (1 - gapRatio))
  const baselineY = padY + chartH
  return points.map(p => ({
    x: p.x - barW / 2,
    y: p.y,
    w: barW,
    h: Math.max(1, baselineY - p.y),
  }))
}

const strokeGradientId = useId()
const areaGradientId = `${strokeGradientId}-area`

const pathD = computed(() => {
  if (values.value.length < 2)
    return ''
  return variant === 'step' ? buildStepPath(values.value) : buildPath(values.value)
})

const bars = computed<BarRect[]>(() => variant === 'bars' ? buildBars(values.value) : [])

const areaPathD = computed(() => {
  if (!pathD.value || variant === 'bars')
    return ''
  const padX = strokeWidth
  const closeY = trend.value === -1 ? strokeWidth : vbH.value - strokeWidth
  return `${pathD.value} L ${vbW.value - padX} ${closeY} L ${padX} ${closeY} Z`
})

const endColor = computed(() => gradientColors.value.at(-1) || '#6b7280')
const areaY1 = computed(() => trend.value === -1 ? '1' : '0')
const areaY2 = computed(() => trend.value === -1 ? '0' : '1')
</script>

<template>
  <svg
    v-if="pathD || bars.length"
    data-ui="UiSparkline"
    :width="cssWidth"
    :height="cssHeight"
    :viewBox="`0 0 ${vbW} ${vbH}`"
    :preserveAspectRatio="preserveAspectRatio"
    role="img"
    :aria-label="`Sparkline showing ${trend === 1 ? 'upward' : trend === -1 ? 'downward' : 'flat'} trend`"
  >
    <defs>
      <linearGradient :id="strokeGradientId" x1="0" y1="0" x2="1" y2="0">
        <stop
          v-for="stop in gradientStops"
          :key="stop.offset"
          :offset="stop.offset"
          :style="{ stopColor: stop.color }"
        />
      </linearGradient>
      <linearGradient :id="areaGradientId" x1="0" :y1="areaY1" x2="0" :y2="areaY2">
        <stop offset="0%" :style="{ stopColor: endColor, stopOpacity: 0.25 }" />
        <stop offset="100%" :style="{ stopColor: endColor, stopOpacity: 0 }" />
      </linearGradient>
    </defs>
    <template v-if="variant === 'bars'">
      <rect
        v-for="(b, i) in bars"
        :key="i"
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        :fill="`url(#${strokeGradientId})`"
        rx="1"
      />
    </template>
    <template v-else>
      <path :d="areaPathD" :fill="`url(#${areaGradientId})`" stroke="none" />
      <path
        :d="pathD"
        :stroke="`url(#${strokeGradientId})`"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
        vector-effect="non-scaling-stroke"
      />
    </template>
  </svg>
</template>
