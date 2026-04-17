<script setup lang="ts">
// Per-anomaly SVG sparkline: CTR line with a shaded ±2σ envelope band from
// the rolling mean, red dots on breach days. No deps — path math only.

interface SeriesPoint {
  date: string
  ctr: number
  rollingCtr: number | null
  rollingStddev: number | null
  z: number
  breach: boolean
  impressions: number
  position: number
}

const props = defineProps<{
  series: SeriesPoint[]
  width?: number
  height?: number
}>()

const W = computed(() => props.width ?? 360)
const H = computed(() => props.height ?? 68)
const PAD = 4

const bounds = computed(() => {
  const all: number[] = []
  for (const p of props.series) {
    all.push(p.ctr)
    if (p.rollingCtr != null && p.rollingStddev != null) {
      all.push(p.rollingCtr + 2 * p.rollingStddev)
      all.push(Math.max(0, p.rollingCtr - 2 * p.rollingStddev))
    }
  }
  const lo = Math.min(...all, 0)
  const hi = Math.max(...all, 0.01)
  return { lo, hi }
})

function xAt(i: number): number {
  if (props.series.length <= 1)
    return W.value / 2
  return PAD + (i / (props.series.length - 1)) * (W.value - PAD * 2)
}

function yAt(v: number): number {
  const { lo, hi } = bounds.value
  const span = hi - lo || 1
  return H.value - PAD - ((v - lo) / span) * (H.value - PAD * 2)
}

// Envelope path: upper edge forward, lower edge back, closed polygon.
const envelopePath = computed(() => {
  const pts = props.series
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.rollingCtr != null && p.rollingStddev != null)
  if (pts.length < 2)
    return ''
  const top = pts.map(({ p, i }) => `${xAt(i).toFixed(1)},${yAt((p.rollingCtr ?? 0) + 2 * (p.rollingStddev ?? 0)).toFixed(1)}`)
  const bot = [...pts].reverse().map(({ p, i }) =>
    `${xAt(i).toFixed(1)},${yAt(Math.max(0, (p.rollingCtr ?? 0) - 2 * (p.rollingStddev ?? 0))).toFixed(1)}`,
  )
  return `M ${top.join(' L ')} L ${bot.join(' L ')} Z`
})

const meanPath = computed(() => {
  const pts = props.series
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.rollingCtr != null)
  if (pts.length < 2)
    return ''
  return `M ${pts.map(({ p, i }) => `${xAt(i).toFixed(1)},${yAt(p.rollingCtr ?? 0).toFixed(1)}`).join(' L ')}`
})

const ctrPath = computed(() => {
  if (props.series.length < 2)
    return ''
  return `M ${props.series.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.ctr).toFixed(1)}`).join(' L ')}`
})

const breaches = computed(() =>
  props.series
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.breach),
)
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H" class="anomaly-chart">
    <path v-if="envelopePath" :d="envelopePath" class="envelope" />
    <path v-if="meanPath" :d="meanPath" class="mean" />
    <path v-if="ctrPath" :d="ctrPath" class="ctr" />
    <circle
      v-for="{ p, i } in breaches" :key="p.date"
      :cx="xAt(i)" :cy="yAt(p.ctr)" r="2.6"
      class="breach"
    >
      <title>{{ p.date }} — CTR {{ (p.ctr * 100).toFixed(2) }}% (z={{ p.z.toFixed(2) }})</title>
    </circle>
  </svg>
</template>

<style scoped>
.anomaly-chart { display: block; }
.envelope { fill: rgba(106, 124, 200, 0.18); stroke: none; }
.mean { fill: none; stroke: rgba(106, 124, 200, 0.55); stroke-width: 1; stroke-dasharray: 3 2; }
.ctr { fill: none; stroke: #1d1d1f; stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
.breach { fill: #e84860; stroke: #fff; stroke-width: 1; }
</style>
