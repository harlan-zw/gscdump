<script setup lang="ts">
// Two-panel viz: (1) scatter of all pages — x = log total impressions,
// y = slope of the log-log power-law fit, colored by fingerprint. Each
// point = one page. (2) on hover/select, the log-log scatter for that
// page with the fitted regression line overlaid.

interface LongTailPoint {
  rank: number
  impressions: number
  clicks: number
  query: string
}

interface LongTailRow {
  page: string
  queryCount: number
  totalImpressions: number
  totalClicks: number
  slope: number
  intercept: number
  r2: number
  headImpressions: number
  headShare: number
  fingerprint: 'flat-tail' | 'balanced' | 'head-heavy'
  points: LongTailPoint[]
}

const props = defineProps<{
  pages: LongTailRow[]
}>()

const W = 900
const H = 420
const PAD_L = 52
const PAD_R = 16
const PAD_T = 16
const PAD_B = 36

const selected = ref<LongTailRow | null>(null)
const hovered = ref<LongTailRow | null>(null)

const scatterBounds = computed(() => {
  if (props.pages.length === 0)
    return { xMin: 0, xMax: 1, yMin: -2, yMax: 0 }
  const xs = props.pages.map(p => Math.log10(Math.max(1, p.totalImpressions)))
  const ys = props.pages.map(p => p.slope)
  return {
    xMin: Math.min(...xs) - 0.1,
    xMax: Math.max(...xs) + 0.1,
    yMin: Math.min(...ys, -2) - 0.1,
    yMax: Math.max(...ys, 0) + 0.1,
  }
})

function sx(impressions: number): number {
  const b = scatterBounds.value
  const lx = Math.log10(Math.max(1, impressions))
  return PAD_L + ((lx - b.xMin) / (b.xMax - b.xMin)) * (W - PAD_L - PAD_R)
}

function sy(slope: number): number {
  const b = scatterBounds.value
  return PAD_T + (1 - (slope - b.yMin) / (b.yMax - b.yMin)) * (H - PAD_T - PAD_B)
}

function radius(p: LongTailRow): number {
  return 3 + Math.sqrt(p.queryCount) * 0.6
}

function fingerprintColor(fp: LongTailRow['fingerprint']): string {
  if (fp === 'flat-tail')
    return '#3cc28a'
  if (fp === 'balanced')
    return '#6a7cc8'
  return '#e84860'
}

const xTicks = computed(() => {
  const b = scatterBounds.value
  const ticks: number[] = []
  for (let v = Math.floor(b.xMin); v <= Math.ceil(b.xMax); v++) ticks.push(v)
  return ticks
})

const yTicks = computed(() => {
  const b = scatterBounds.value
  const ticks: number[] = []
  const step = Math.max(0.2, (b.yMax - b.yMin) / 6)
  for (let v = Math.ceil(b.yMin / step) * step; v <= b.yMax; v += step) ticks.push(Math.round(v * 10) / 10)
  return ticks
})

const detail = computed(() => selected.value ?? hovered.value ?? null)

// Inner log-log panel (for selected page).
const INNER_W = 360
const INNER_H = 200
const IP_L = 36
const IP_R = 8
const IP_T = 8
const IP_B = 28

const innerBounds = computed(() => {
  const d = detail.value
  if (d == null || d.points.length === 0)
    return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }
  const ranks = d.points.map(p => Math.log10(Math.max(1, p.rank)))
  const imprs = d.points.map(p => Math.log10(Math.max(1, p.impressions)))
  return {
    xMin: Math.min(...ranks),
    xMax: Math.max(...ranks) + 0.05,
    yMin: Math.min(...imprs) - 0.1,
    yMax: Math.max(...imprs) + 0.1,
  }
})

function ix(logR: number): number {
  const b = innerBounds.value
  return IP_L + ((logR - b.xMin) / (b.xMax - b.xMin)) * (INNER_W - IP_L - IP_R)
}

function iy(logI: number): number {
  const b = innerBounds.value
  return IP_T + (1 - (logI - b.yMin) / (b.yMax - b.yMin)) * (INNER_H - IP_T - IP_B)
}

const fitLine = computed(() => {
  const d = detail.value
  if (d == null)
    return null
  // Regression is on ln(rank), ln(impressions). Convert to log10 grid.
  const b = innerBounds.value
  const lnFromLog10 = Math.LN10
  const f = (log10R: number) => {
    const lnR = log10R * lnFromLog10
    const lnI = d.intercept + d.slope * lnR
    return lnI / lnFromLog10
  }
  return {
    x1: ix(b.xMin),
    y1: iy(f(b.xMin)),
    x2: ix(b.xMax),
    y2: iy(f(b.xMax)),
  }
})

const ORIGIN_RE = /^https?:\/\/[^/]+/

function shortUrl(u: string): string {
  const trimmed = u.replace(ORIGIN_RE, '')
  if (trimmed.length <= 40)
    return trimmed || '/'
  return `…${trimmed.slice(-38)}`
}
</script>

<template>
  <div class="lt-wrap">
    <div class="lt-main">
      <svg :viewBox="`0 0 ${W} ${H}`" class="lt-scatter">
        <!-- x-axis -->
        <line :x1="PAD_L" :y1="H - PAD_B" :x2="W - PAD_R" :y2="H - PAD_B" class="axis" />
        <g v-for="t in xTicks" :key="`x${t}`">
          <line :x1="sx(10 ** t)" :y1="H - PAD_B" :x2="sx(10 ** t)" :y2="H - PAD_B + 4" class="tick" />
          <text :x="sx(10 ** t)" :y="H - PAD_B + 16" text-anchor="middle" class="tick-label">
            10<tspan dy="-3" font-size="8">{{ t }}</tspan>
          </text>
        </g>
        <text :x="(W - PAD_R + PAD_L) / 2" :y="H - 6" text-anchor="middle" class="axis-label">
          total impressions (log₁₀)
        </text>

        <!-- y-axis -->
        <line :x1="PAD_L" :y1="PAD_T" :x2="PAD_L" :y2="H - PAD_B" class="axis" />
        <g v-for="t in yTicks" :key="`y${t}`">
          <line :x1="PAD_L - 4" :y1="sy(t)" :x2="PAD_L" :y2="sy(t)" class="tick" />
          <text :x="PAD_L - 8" :y="sy(t) + 3" text-anchor="end" class="tick-label">{{ t.toFixed(1) }}</text>
        </g>
        <text :x="14" :y="(H - PAD_B + PAD_T) / 2" text-anchor="middle" class="axis-label" :transform="`rotate(-90 14 ${(H - PAD_B + PAD_T) / 2})`">
          power-law slope
        </text>

        <!-- fingerprint bands -->
        <line :x1="PAD_L" :y1="sy(-0.6)" :x2="W - PAD_R" :y2="sy(-0.6)" class="band" />
        <line :x1="PAD_L" :y1="sy(-1.2)" :x2="W - PAD_R" :y2="sy(-1.2)" class="band" />
        <text :x="W - PAD_R - 4" :y="sy(-0.3)" text-anchor="end" class="band-label" fill="#3cc28a">flat-tail (authority)</text>
        <text :x="W - PAD_R - 4" :y="sy(-0.9)" text-anchor="end" class="band-label" fill="#6a7cc8">balanced</text>
        <text :x="W - PAD_R - 4" :y="sy(-1.5)" text-anchor="end" class="band-label" fill="#e84860">head-heavy</text>

        <!-- points -->
        <g>
          <circle
            v-for="p in props.pages" :key="p.page"
            :cx="sx(p.totalImpressions)" :cy="sy(p.slope)" :r="radius(p)"
            :fill="fingerprintColor(p.fingerprint)"
            :class="{ selected: selected?.page === p.page, hovered: hovered?.page === p.page }"
            @mouseenter="hovered = p"
            @mouseleave="hovered = null"
            @click="selected = selected?.page === p.page ? null : p"
          >
            <title>{{ p.page }} · slope {{ p.slope.toFixed(2) }} · {{ p.queryCount }} queries</title>
          </circle>
        </g>
      </svg>
    </div>

    <aside class="lt-detail">
      <div v-if="detail" class="detail-pane">
        <div class="detail-head">
          <div class="detail-url" :title="detail.page">
            {{ shortUrl(detail.page) }}
          </div>
          <div class="detail-tag" :style="{ color: fingerprintColor(detail.fingerprint) }">
            {{ detail.fingerprint }}
          </div>
        </div>
        <div class="detail-stats">
          <div><span>slope</span><b>{{ detail.slope.toFixed(2) }}</b></div>
          <div><span>R²</span><b>{{ detail.r2.toFixed(3) }}</b></div>
          <div><span>queries</span><b>{{ detail.queryCount }}</b></div>
          <div><span>head share</span><b>{{ (detail.headShare * 100).toFixed(1) }}%</b></div>
          <div><span>impressions</span><b>{{ Math.round(detail.totalImpressions).toLocaleString() }}</b></div>
        </div>
        <svg :viewBox="`0 0 ${INNER_W} ${INNER_H}`" class="lt-inner">
          <!-- inner axes -->
          <line :x1="IP_L" :y1="INNER_H - IP_B" :x2="INNER_W - IP_R" :y2="INNER_H - IP_B" class="axis" />
          <line :x1="IP_L" :y1="IP_T" :x2="IP_L" :y2="INNER_H - IP_B" class="axis" />
          <text :x="(INNER_W + IP_L) / 2" :y="INNER_H - 6" text-anchor="middle" class="axis-label">log₁₀(rank)</text>
          <text :x="12" :y="(INNER_H - IP_B + IP_T) / 2" text-anchor="middle" class="axis-label" :transform="`rotate(-90 12 ${(INNER_H - IP_B + IP_T) / 2})`">log₁₀(impr)</text>

          <!-- fit line -->
          <line
            v-if="fitLine"
            :x1="fitLine.x1" :y1="fitLine.y1" :x2="fitLine.x2" :y2="fitLine.y2"
            class="fit-line"
          />
          <!-- scatter points -->
          <circle
            v-for="(p, i) in detail.points" :key="i"
            :cx="ix(Math.log10(Math.max(1, p.rank)))"
            :cy="iy(Math.log10(Math.max(1, p.impressions)))"
            :r="p.rank === 1 ? 3.5 : 2"
            :fill="p.rank === 1 ? '#ff9bb3' : '#b9bccc'"
          >
            <title>{{ p.query }} · rank {{ p.rank }} · {{ p.impressions.toLocaleString() }} impr</title>
          </circle>
        </svg>
      </div>
      <div v-else class="detail-empty">
        Hover a point to see its distribution.
        <br><br>
        Flat slopes (-0.6 to 0) = topic authority.<br>
        Steep slopes (&lt; -1.2) = single-keyword dependency.
      </div>
    </aside>
  </div>
</template>

<style scoped>
.lt-wrap { display: grid; grid-template-columns: 1fr 400px; gap: 0; background: #13141e; color: #e8e8f0; border-radius: 6px; overflow: hidden; }
.lt-main { padding: 0.4rem; }
.lt-scatter { width: 100%; height: auto; display: block; background: radial-gradient(circle at 50% 40%, #1a1b2e 0%, #0c0d14 80%); border-radius: 4px; }
.axis { stroke: #3a3d52; stroke-width: 1; }
.tick { stroke: #3a3d52; stroke-width: 1; }
.tick-label { fill: #8b8ea5; font-size: 10px; font-family: ui-monospace, monospace; }
.axis-label { fill: #8b8ea5; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
.band { stroke: rgba(255, 255, 255, 0.08); stroke-dasharray: 3 3; stroke-width: 1; }
.band-label { font-size: 9px; font-family: ui-monospace, monospace; letter-spacing: 0.04em; opacity: 0.7; }
circle { cursor: pointer; transition: stroke-width 0.1s; stroke: rgba(12, 13, 20, 0.4); stroke-width: 1; }
circle.hovered { stroke: #fff; stroke-width: 2; }
circle.selected { stroke: #fff; stroke-width: 2.5; }
.lt-detail { background: #0c0d14; border-left: 1px solid #1d1f2e; padding: 0.75rem 0.85rem; }
.detail-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; margin-bottom: 0.4rem; }
.detail-url { font-family: ui-monospace, monospace; font-size: 0.78rem; color: #b9bccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.detail-tag { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.detail-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 0.2rem 0.6rem; font-size: 0.72rem; color: #8b8ea5; margin-bottom: 0.6rem; }
.detail-stats > div { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
.detail-stats b { color: #e8e8f0; }
.lt-inner { width: 100%; height: auto; background: #13141e; border-radius: 4px; }
.fit-line { stroke: #ff9bb3; stroke-width: 1.5; stroke-dasharray: 4 3; opacity: 0.8; }
.detail-empty { font-size: 0.78rem; color: #8b8ea5; padding: 1.5rem 0.5rem; text-align: center; line-height: 1.5; }

@media (max-width: 920px) {
  .lt-wrap { grid-template-columns: 1fr; }
  .lt-detail { border-left: 0; border-top: 1px solid #1d1f2e; }
}
</style>
