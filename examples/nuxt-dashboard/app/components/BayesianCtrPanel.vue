<script setup lang="ts">
// Empirical-Bayes CTR shrinkage panel. Each row is one (keyword, page)
// entity; the horizontal bar shows the posterior 95% CI band, the
// observed CTR as a dot, and the bucket's prior mean as a ghost tick.

interface BayesianCtrRow {
  keyword: string
  page: string
  clicks: number
  impressions: number
  observedCtr: number
  position: number
  bucket: number
  priorAlpha: number
  priorBeta: number
  bucketPriorMean: number
  posteriorMean: number
  posteriorSd: number
  ciLow: number
  ciHigh: number
  shrinkageDelta: number
  expectedClicksDelta: number
  significance: number
  classification: 'overperforming' | 'underperforming' | 'expected'
}

const props = defineProps<{ rows: BayesianCtrRow[] }>()

const BAR_W = 220
const BAR_H = 14

const ctrMax = computed(() => {
  let m = 0
  for (const r of props.rows) {
    if (r.observedCtr > m)
      m = r.observedCtr
    if (r.ciHigh > m)
      m = r.ciHigh
    if (r.bucketPriorMean > m)
      m = r.bucketPriorMean
  }
  // Round up to a clean 5% tick.
  return Math.max(0.05, Math.ceil((m + 0.01) * 20) / 20)
})

function xAt(v: number): number {
  return (Math.min(v, ctrMax.value) / ctrMax.value) * BAR_W
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

function fmtDelta(v: number): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(0)}`
}

function classColor(c: BayesianCtrRow['classification']): string {
  if (c === 'overperforming')
    return '#3cc28a'
  if (c === 'underperforming')
    return '#e84860'
  return '#b9bccc'
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
</script>

<template>
  <div class="bayes-panel">
    <div v-if="rows.length === 0" class="empty">
      No entities above the impression threshold.
    </div>
    <ol v-else class="rows">
      <li v-for="(r, i) in rows" :key="`${r.keyword}::${r.page}`" class="row">
        <div class="rank">
          {{ i + 1 }}
        </div>
        <div class="left">
          <div class="kw" :title="r.keyword">
            {{ truncate(r.keyword, 42) }}
          </div>
          <div class="page" :title="r.page">
            {{ truncate(r.page, 42) }}
          </div>
          <div class="meta">
            {{ r.impressions.toLocaleString() }} impr · pos {{ r.position.toFixed(1) }} · bucket {{ r.bucket }}
          </div>
        </div>
        <div class="center">
          <svg :viewBox="`0 0 ${BAR_W} ${BAR_H}`" :width="BAR_W" :height="BAR_H" class="bar">
            <rect x="0" :y="BAR_H / 2 - 1" :width="BAR_W" height="2" class="axis" />
            <rect
              :x="xAt(r.ciLow)"
              y="2"
              :width="Math.max(1, xAt(r.ciHigh) - xAt(r.ciLow))"
              :height="BAR_H - 4"
              class="ci"
            />
            <line
              :x1="xAt(r.posteriorMean)" :x2="xAt(r.posteriorMean)"
              y1="1" :y2="BAR_H - 1" class="post"
            />
            <line
              :x1="xAt(r.bucketPriorMean)" :x2="xAt(r.bucketPriorMean)"
              y1="3" :y2="BAR_H - 3" class="ghost"
            />
            <circle
              :cx="xAt(r.observedCtr)" :cy="BAR_H / 2" r="3.5"
              :fill="classColor(r.classification)" class="obs"
            >
              <title>
                observed {{ fmtPct(r.observedCtr) }} · posterior {{ fmtPct(r.posteriorMean) }}
                (CI {{ fmtPct(r.ciLow) }}–{{ fmtPct(r.ciHigh) }})
              </title>
            </circle>
          </svg>
          <div class="scale">
            <span>0%</span>
            <span>{{ (ctrMax * 100).toFixed(0) }}%</span>
          </div>
        </div>
        <div class="right">
          <div class="stat">
            <span class="lbl">obs</span>
            <span class="val">{{ fmtPct(r.observedCtr) }}</span>
          </div>
          <div class="stat">
            <span class="lbl">post</span>
            <span class="val">{{ fmtPct(r.posteriorMean) }}</span>
          </div>
          <div class="stat">
            <span class="lbl">Δclk</span>
            <span
              class="val"
              :style="{ color: r.expectedClicksDelta >= 0 ? '#3cc28a' : '#e84860' }"
            >{{ fmtDelta(r.expectedClicksDelta) }}</span>
          </div>
          <span class="tag" :style="{ color: classColor(r.classification), borderColor: classColor(r.classification) }">
            {{ r.classification }}
          </span>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.bayes-panel {
  background: #0c0d14;
  color: #b9bccc;
  font: 12px/1.4 ui-monospace, monospace;
  border-radius: 6px;
  max-height: 640px;
  overflow-y: auto;
  padding: 8px;
}
.empty { padding: 24px; text-align: center; opacity: 0.6; }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
  display: grid;
  grid-template-columns: 24px 1fr auto 1fr;
  gap: 12px;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(185, 188, 204, 0.08);
}
.row:last-child { border-bottom: none; }
.rank { color: rgba(185, 188, 204, 0.4); text-align: right; font-variant-numeric: tabular-nums; }
.left { min-width: 180px; overflow: hidden; }
.kw { color: #e8e9f0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page { color: #6a7cc8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: rgba(185, 188, 204, 0.55); font-size: 10.5px; margin-top: 2px; }
.center { display: flex; flex-direction: column; gap: 2px; }
.bar { display: block; }
.axis { fill: rgba(185, 188, 204, 0.12); }
.ci { fill: rgba(106, 124, 200, 0.28); }
.post { stroke: #6a7cc8; stroke-width: 1.5; }
.ghost { stroke: rgba(185, 188, 204, 0.45); stroke-width: 1; stroke-dasharray: 2 2; }
.obs { stroke: #0c0d14; stroke-width: 1.5; }
.scale {
  display: flex;
  justify-content: space-between;
  font-size: 9.5px;
  color: rgba(185, 188, 204, 0.4);
}
.right {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
  font-variant-numeric: tabular-nums;
}
.stat { display: flex; flex-direction: column; align-items: flex-end; min-width: 46px; }
.lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: rgba(185, 188, 204, 0.45); }
.val { color: #e8e9f0; }
.tag {
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  min-width: 100px;
  text-align: center;
}
</style>
