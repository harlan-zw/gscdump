<script setup lang="ts">
// Scrollable list. Each row = one entity sparkline with a vertical red
// line at changeDate and dashed horizontal lines at leftMean / rightMean.
// A tag shows "improved" or "worsened" colored green/red. LLR score rendered
// as a numeric badge.

interface SeriesPoint { date: string, value: number }

interface Entity {
  keyword: string
  page: string
  totalDays: number
  changeDate: string
  llr: number
  leftMean: number
  rightMean: number
  delta: number
  leftStddev: number
  rightStddev: number
  direction: 'improved' | 'worsened'
  series: SeriesPoint[]
}

const props = defineProps<{
  entities: Entity[]
  metric?: 'clicks' | 'impressions' | 'position'
}>()

const W = 520
const H = 64
const PAD_X = 6
const PAD_Y = 6

function bounds(e: Entity): { lo: number, hi: number } {
  const vals = e.series.map(s => s.value).filter(Number.isFinite)
  vals.push(e.leftMean, e.rightMean)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  if (lo === hi)
    return { lo: lo - 1, hi: hi + 1 }
  const pad = (hi - lo) * 0.08
  return { lo: lo - pad, hi: hi + pad }
}

function xAt(i: number, n: number): number {
  if (n <= 1)
    return W / 2
  return PAD_X + (i / (n - 1)) * (W - PAD_X * 2)
}

function yAt(v: number, lo: number, hi: number): number {
  const span = hi - lo || 1
  return H - PAD_Y - ((v - lo) / span) * (H - PAD_Y * 2)
}

function buildPath(e: Entity, b: { lo: number, hi: number }): string {
  if (e.series.length < 2)
    return ''
  return `M ${e.series.map((s, i) => `${xAt(i, e.series.length).toFixed(1)},${yAt(s.value, b.lo, b.hi).toFixed(1)}`).join(' L ')}`
}

function changeIndex(e: Entity): number {
  const idx = e.series.findIndex(s => s.date === e.changeDate)
  return idx >= 0 ? idx : Math.floor(e.series.length / 2)
}
</script>

<template>
  <div class="cp-panel">
    <header class="panel-header">
      <h3>Change-point detection</h3>
      <span class="panel-sub">
        {{ entities.length }} detected · {{ props.metric ?? 'position' }} · argmax Gaussian LLR
      </span>
    </header>
    <div class="scroll">
      <div
        v-for="entity in entities"
        :key="`${entity.keyword}||${entity.page}`"
        class="row"
      >
        <div class="row-head">
          <div class="row-title">
            <div class="keyword">
              {{ entity.keyword }}
            </div>
            <div class="page">
              {{ entity.page }}
            </div>
          </div>
          <div class="badges">
            <span class="badge mono">
              LLR {{ entity.llr.toFixed(1) }}
            </span>
            <span class="badge mono">
              {{ entity.changeDate }}
            </span>
            <span
              class="badge"
              :class="entity.direction === 'improved' ? 'badge-green' : 'badge-red'"
            >
              {{ entity.direction }}
            </span>
          </div>
        </div>
        <div class="chart">
          <svg :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H">
            <!-- left-mean dashed line -->
            <line
              :x1="PAD_X" :y1="yAt(entity.leftMean, bounds(entity).lo, bounds(entity).hi)"
              :x2="xAt(changeIndex(entity), entity.series.length)"
              :y2="yAt(entity.leftMean, bounds(entity).lo, bounds(entity).hi)"
              class="mean-line"
            />
            <!-- right-mean dashed line -->
            <line
              :x1="xAt(changeIndex(entity), entity.series.length)"
              :y1="yAt(entity.rightMean, bounds(entity).lo, bounds(entity).hi)"
              :x2="W - PAD_X"
              :y2="yAt(entity.rightMean, bounds(entity).lo, bounds(entity).hi)"
              class="mean-line"
            />
            <!-- change vertical -->
            <line
              :x1="xAt(changeIndex(entity), entity.series.length)" :y1="PAD_Y"
              :x2="xAt(changeIndex(entity), entity.series.length)" :y2="H - PAD_Y"
              class="change-line"
            />
            <!-- value series -->
            <path :d="buildPath(entity, bounds(entity))" class="value-line" />
          </svg>
          <div class="meta">
            <span class="mono">μ₁ {{ entity.leftMean.toFixed(2) }}</span>
            <span class="mono">→</span>
            <span class="mono">μ₂ {{ entity.rightMean.toFixed(2) }}</span>
            <span class="sep">·</span>
            <span class="mono">Δ {{ entity.delta >= 0 ? '+' : '' }}{{ entity.delta.toFixed(2) }}</span>
            <span class="sep">·</span>
            <span class="mono">σ₁ {{ entity.leftStddev.toFixed(2) }} / σ₂ {{ entity.rightStddev.toFixed(2) }}</span>
          </div>
        </div>
      </div>
      <div v-if="entities.length === 0" class="empty">
        No change-points detected above the LLR threshold.
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp-panel {
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
.panel-sub { color: #6a6d7a; }
.scroll {
  max-height: 520px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  border: 1px solid #161824;
  border-radius: 6px;
  padding: 8px 10px;
  background: #10111a;
}
.row-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 6px;
}
.row-title { min-width: 0; }
.keyword {
  color: #e7e8f0;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.page {
  color: #6a6d7a;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badges { display: flex; gap: 4px; flex-shrink: 0; }
.badge {
  padding: 2px 6px;
  border-radius: 3px;
  background: #1a1c26;
  color: #b9bccc;
  font-size: 10px;
}
.mono { font-variant-numeric: tabular-nums; }
.badge-green { background: rgba(60, 194, 138, 0.14); color: #3cc28a; }
.badge-red { background: rgba(232, 72, 96, 0.14); color: #e84860; }
.chart { display: flex; flex-direction: column; gap: 4px; }
.value-line {
  fill: none;
  stroke: #e7e8f0;
  stroke-width: 1.4;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.mean-line {
  stroke: #6a7cc8;
  stroke-width: 1;
  stroke-dasharray: 3 2;
}
.change-line {
  stroke: #e84860;
  stroke-width: 1.2;
  stroke-dasharray: 2 2;
}
.meta {
  display: flex;
  gap: 6px;
  color: #6a6d7a;
  font-size: 10px;
  padding: 0 4px;
}
.sep { color: #2a2d3a; }
.empty { padding: 20px; text-align: center; color: #6a6d7a; }
</style>
