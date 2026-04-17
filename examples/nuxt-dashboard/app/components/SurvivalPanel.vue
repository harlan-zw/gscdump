<script setup lang="ts">
// Kaplan-Meier survival curves per cohort. Step-function overlay SVG:
// x = tenure (days), y = S(t) in [0..1]. Each cohort gets a distinct hue
// and a vertical drop at its median tenure.

interface CurvePoint {
  tenure: number
  survival: number
  atRisk: number
  events: number
}

interface Cohort {
  cohort: string
  episodeCount: number
  censoringRate: number
  medianTenure: number
  curve: CurvePoint[]
}

const props = defineProps<{
  cohorts: Cohort[]
  windowDays?: number
}>()

const W = 640
const H = 300
const PAD_L = 36
const PAD_R = 12
const PAD_T = 12
const PAD_B = 28

// Deterministic palette cycled by cohort name so colors are stable across
// re-renders. Dark-theme friendly.
const PALETTE = [
  '#6ac1ff',
  '#ffb86c',
  '#3cc28a',
  '#e84860',
  '#bd93f9',
  '#8dd3a0',
  '#f5c24b',
  '#9ea2b3',
]

// "__all__" is rendered first so cohort-specific curves draw on top.
const ordered = computed(() => {
  const all = props.cohorts.filter(c => c.cohort === '__all__')
  const rest = props.cohorts
    .filter(c => c.cohort !== '__all__')
    .sort((a, b) => b.episodeCount - a.episodeCount)
  return [...all, ...rest]
})

const maxTenure = computed(() => {
  let m = 1
  for (const c of props.cohorts) {
    for (const p of c.curve) {
      if (p.tenure > m)
        m = p.tenure
    }
  }
  return Math.max(m, props.windowDays ?? 0)
})

function xAt(t: number): number {
  const m = maxTenure.value || 1
  return PAD_L + (t / m) * (W - PAD_L - PAD_R)
}

function yAt(s: number): number {
  return PAD_T + (1 - s) * (H - PAD_T - PAD_B)
}

// Step-function path: from (0, 1) hold horizontally to each event tenure,
// then drop vertically to the new S(t). Emits pure L segments (no curves).
function buildStepPath(curve: CurvePoint[]): string {
  if (curve.length === 0)
    return ''
  const sorted = [...curve].sort((a, b) => a.tenure - b.tenure)
  const parts: string[] = []
  parts.push(`M ${xAt(0).toFixed(1)},${yAt(1).toFixed(1)}`)
  let prevS = 1
  for (const p of sorted) {
    // horizontal hold to current tenure at previous S
    parts.push(`L ${xAt(p.tenure).toFixed(1)},${yAt(prevS).toFixed(1)}`)
    // vertical drop to new S
    parts.push(`L ${xAt(p.tenure).toFixed(1)},${yAt(p.survival).toFixed(1)}`)
    prevS = p.survival
  }
  // extend to the right edge so the curve reaches the window boundary
  parts.push(`L ${xAt(maxTenure.value).toFixed(1)},${yAt(prevS).toFixed(1)}`)
  return parts.join(' ')
}

function colorFor(cohort: string, idx: number): string {
  if (cohort === '__all__')
    return '#e7e8f0'
  return PALETTE[idx % PALETTE.length]
}

const xTicks = computed(() => {
  const m = maxTenure.value
  const step = m > 120 ? 30 : m > 60 ? 14 : m > 21 ? 7 : 1
  const out: number[] = []
  for (let t = 0; t <= m; t += step) out.push(t)
  if (out[out.length - 1] !== m)
    out.push(m)
  return out
})
const yTicks = [0, 0.25, 0.5, 0.75, 1]
</script>

<template>
  <div class="sv-panel">
    <header class="panel-header">
      <h3>Keyword survival</h3>
      <span class="panel-sub">
        Kaplan-Meier · probability a query stays top-10 after N days ·
        {{ ordered.length }} cohort{{ ordered.length === 1 ? '' : 's' }}
      </span>
    </header>

    <div class="body">
      <div class="chart">
        <svg :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H">
          <!-- y gridlines -->
          <g class="grid">
            <line
              v-for="y in yTicks"
              :key="`y${y}`"
              :x1="PAD_L"
              :x2="W - PAD_R"
              :y1="yAt(y)"
              :y2="yAt(y)"
            />
          </g>
          <!-- median reference line at S=0.5 -->
          <line
            :x1="PAD_L"
            :x2="W - PAD_R"
            :y1="yAt(0.5)"
            :y2="yAt(0.5)"
            class="median-line"
          />
          <!-- y axis labels -->
          <g class="axis">
            <text
              v-for="y in yTicks"
              :key="`yt${y}`"
              :x="PAD_L - 6"
              :y="yAt(y) + 3"
              text-anchor="end"
            >
              {{ y.toFixed(2) }}
            </text>
          </g>
          <!-- x axis labels -->
          <g class="axis">
            <text
              v-for="t in xTicks"
              :key="`xt${t}`"
              :x="xAt(t)"
              :y="H - PAD_B + 14"
              text-anchor="middle"
            >
              {{ t }}
            </text>
            <text
              :x="(PAD_L + W - PAD_R) / 2"
              :y="H - 4"
              class="axis-label"
              text-anchor="middle"
            >
              tenure (days)
            </text>
          </g>

          <!-- step curves -->
          <path
            v-for="(c, i) in ordered"
            :key="`curve-${c.cohort}`"
            :d="buildStepPath(c.curve)"
            :stroke="colorFor(c.cohort, i)"
            :stroke-dasharray="c.cohort === '__all__' ? '4 3' : ''"
            class="curve"
          />

          <!-- per-cohort median drops -->
          <g>
            <template v-for="(c, i) in ordered" :key="`med-${c.cohort}`">
              <line
                v-if="c.medianTenure > 0"
                :x1="xAt(c.medianTenure)"
                :x2="xAt(c.medianTenure)"
                :y1="yAt(0.5)"
                :y2="H - PAD_B"
                :stroke="colorFor(c.cohort, i)"
                class="median-drop"
              />
            </template>
          </g>
        </svg>
      </div>

      <aside class="sidebar">
        <div class="sidebar-head">
          Cohorts
        </div>
        <table class="stats">
          <thead>
            <tr>
              <th>cohort</th>
              <th class="num">
                n
              </th>
              <th class="num">
                median
              </th>
              <th class="num">
                cens.
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in ordered" :key="c.cohort">
              <td>
                <span class="swatch" :style="{ background: colorFor(c.cohort, i) }" />
                <span class="label">{{ c.cohort === '__all__' ? 'all' : c.cohort }}</span>
              </td>
              <td class="num mono">
                {{ c.episodeCount }}
              </td>
              <td class="num mono">
                {{ c.medianTenure > 0 ? `${c.medianTenure.toFixed(1)}d` : '—' }}
              </td>
              <td class="num mono">
                {{ Math.round(c.censoringRate * 100) }}%
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="ordered.length === 0" class="empty">
          No episodes in window.
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.sv-panel {
  background: #0c0d14;
  color: #b9bccc;
  border-radius: 8px;
  padding: 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #1a1c26;
}
.panel-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: #e7e8f0;
  margin: 0;
}
.panel-sub {
  color: #6a6d7a;
}
.body {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: 16px;
  align-items: start;
}
.chart {
  background: #10111a;
  border: 1px solid #161824;
  border-radius: 6px;
  padding: 4px;
}
.curve {
  fill: none;
  stroke-width: 1.6;
  stroke-linejoin: miter;
  stroke-linecap: butt;
}
.grid line {
  stroke: #1a1c26;
  stroke-width: 1;
}
.median-line {
  stroke: #2a2d3a;
  stroke-width: 1;
  stroke-dasharray: 5 4;
}
.median-drop {
  stroke-width: 1;
  stroke-dasharray: 2 3;
  opacity: 0.55;
}
.axis text {
  fill: #6a6d7a;
  font-size: 9px;
}
.axis-label {
  fill: #9095a8;
  font-size: 10px;
}
.sidebar {
  background: #10111a;
  border: 1px solid #161824;
  border-radius: 6px;
  padding: 8px 10px;
}
.sidebar-head {
  color: #9095a8;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 6px;
}
.stats {
  width: 100%;
  border-collapse: collapse;
}
.stats th {
  color: #6a6d7a;
  font-weight: 500;
  text-align: left;
  padding: 3px 4px;
  border-bottom: 1px solid #1a1c26;
  font-size: 10px;
}
.stats td {
  padding: 4px;
  border-bottom: 1px solid #13151e;
  color: #b9bccc;
}
.stats .num {
  text-align: right;
}
.mono {
  font-variant-numeric: tabular-nums;
}
.swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: middle;
}
.label {
  color: #e7e8f0;
}
.empty {
  padding: 12px;
  text-align: center;
  color: #6a6d7a;
}
</style>
