<script setup lang="ts">
// Scrollable list. Each row shows a (query, url) entity with four stacked
// mini-sparklines: observed (top), trend, seasonal, residual. Residual
// points flagged `anomaly: true` render in red. Seasonal/trend strengths
// appear as badges on the row header.

interface SeriesPoint {
  date: string
  observed: number
  trend: number | null
  seasonal: number | null
  residual: number | null
  anomaly: boolean
}

interface Entity {
  keyword: string
  page: string
  totalImpressions: number
  days: number
  seasonalStrength: number
  trendStrength: number
  residualAnomalies: number
  trendSlope: number
  series: SeriesPoint[]
}

const props = defineProps<{
  entities: Entity[]
  metric?: 'clicks' | 'impressions'
}>()

const SPARK_W = 200
const SPARK_H = 32
const PAD = 3

function domain(values: Array<number | null | undefined>): { lo: number, hi: number } {
  const vals = values.filter((v): v is number => v != null && Number.isFinite(v))
  if (vals.length === 0)
    return { lo: 0, hi: 1 }
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  if (lo === hi)
    return { lo: lo - 1, hi: hi + 1 }
  return { lo, hi }
}

function xAt(i: number, n: number): number {
  if (n <= 1)
    return SPARK_W / 2
  return PAD + (i / (n - 1)) * (SPARK_W - PAD * 2)
}

function yAt(v: number, lo: number, hi: number): number {
  const span = hi - lo || 1
  return SPARK_H - PAD - ((v - lo) / span) * (SPARK_H - PAD * 2)
}

function buildPath(series: SeriesPoint[], pick: (p: SeriesPoint) => number | null): string {
  const dom = domain(series.map(pick))
  const segs: string[] = []
  let pending = false
  for (let i = 0; i < series.length; i++) {
    const v = pick(series[i])
    if (v == null || !Number.isFinite(v)) {
      pending = false
      continue
    }
    const x = xAt(i, series.length).toFixed(1)
    const y = yAt(v, dom.lo, dom.hi).toFixed(1)
    segs.push(`${pending ? 'L' : 'M'} ${x},${y}`)
    pending = true
  }
  return segs.join(' ')
}

function zeroPath(series: SeriesPoint[], pick: (p: SeriesPoint) => number | null): string {
  // Baseline at 0 for seasonal/residual panels (if 0 is in domain).
  const dom = domain(series.map(pick))
  if (dom.lo > 0 || dom.hi < 0)
    return ''
  const y = yAt(0, dom.lo, dom.hi).toFixed(1)
  return `M ${PAD},${y} L ${SPARK_W - PAD},${y}`
}

function anomalyDots(series: SeriesPoint[]): Array<{ x: number, y: number, p: SeriesPoint }> {
  const dom = domain(series.map(s => s.residual))
  const out: Array<{ x: number, y: number, p: SeriesPoint }> = []
  for (let i = 0; i < series.length; i++) {
    const p = series[i]
    if (p.anomaly && p.residual != null) {
      out.push({ x: xAt(i, series.length), y: yAt(p.residual, dom.lo, dom.hi), p })
    }
  }
  return out
}
</script>

<template>
  <div class="stl-panel">
    <header class="panel-header">
      <h3>STL decomposition</h3>
      <span class="panel-sub">
        {{ entities.length }} entities · {{ props.metric ?? 'impressions' }} · observed / trend / seasonal / residual
      </span>
    </header>
    <div class="scroll">
      <div
        v-for="entity in entities.slice(0, 10)"
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
            <span class="badge" title="seasonal strength (var(seasonal)/var(detrended))">
              season {{ (entity.seasonalStrength * 100).toFixed(0) }}%
            </span>
            <span class="badge" title="trend strength (1 − var(residual)/var(detrended))">
              trend {{ (entity.trendStrength * 100).toFixed(0) }}%
            </span>
            <span class="badge badge-red">
              {{ entity.residualAnomalies }} anomal{{ entity.residualAnomalies === 1 ? 'y' : 'ies' }}
            </span>
          </div>
        </div>
        <div class="sparks">
          <div class="spark">
            <span class="spark-label">obs</span>
            <svg :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`" :width="SPARK_W" :height="SPARK_H">
              <path :d="buildPath(entity.series, s => s.observed)" class="line line-obs" />
            </svg>
          </div>
          <div class="spark">
            <span class="spark-label">trd</span>
            <svg :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`" :width="SPARK_W" :height="SPARK_H">
              <path :d="buildPath(entity.series, s => s.trend)" class="line line-trend" />
            </svg>
          </div>
          <div class="spark">
            <span class="spark-label">ssn</span>
            <svg :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`" :width="SPARK_W" :height="SPARK_H">
              <path :d="zeroPath(entity.series, s => s.seasonal)" class="zero" />
              <path :d="buildPath(entity.series, s => s.seasonal)" class="line line-seasonal" />
            </svg>
          </div>
          <div class="spark">
            <span class="spark-label">res</span>
            <svg :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`" :width="SPARK_W" :height="SPARK_H">
              <path :d="zeroPath(entity.series, s => s.residual)" class="zero" />
              <path :d="buildPath(entity.series, s => s.residual)" class="line line-residual" />
              <circle
                v-for="(dot, j) in anomalyDots(entity.series)"
                :key="j"
                :cx="dot.x" :cy="dot.y" r="2.2" class="anomaly"
              >
                <title>{{ dot.p.date }} · residual {{ (dot.p.residual ?? 0).toFixed(1) }}</title>
              </circle>
            </svg>
          </div>
        </div>
      </div>
      <div v-if="entities.length === 0" class="empty">
        No entities with enough data (need ≥ 21 days).
      </div>
    </div>
  </div>
</template>

<style scoped>
.stl-panel {
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
.badge-red { background: rgba(232, 72, 96, 0.14); color: #e84860; }
.sparks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.spark { display: flex; align-items: center; gap: 4px; }
.spark-label {
  color: #6a6d7a;
  width: 22px;
  font-size: 9px;
}
.line { fill: none; stroke-width: 1.2; stroke-linejoin: round; stroke-linecap: round; }
.line-obs { stroke: #e7e8f0; }
.line-trend { stroke: #6a7cc8; }
.line-seasonal { stroke: #3cc28a; }
.line-residual { stroke: #b9bccc; }
.zero { fill: none; stroke: #252836; stroke-width: 1; stroke-dasharray: 2 2; }
.anomaly { fill: #e84860; stroke: #0c0d14; stroke-width: 1; }
.empty { padding: 20px; text-align: center; color: #6a6d7a; }
</style>
