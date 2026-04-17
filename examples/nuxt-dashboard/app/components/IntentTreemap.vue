<script setup lang="ts">
// Squarified treemap: each tile is a token-cluster sized by total impressions.
// Pure layout — no d3 — using the squarify recursion.

interface Cluster {
  clusterKey: string
  keywordCount: number
  totalImpressions: number
  totalClicks: number
  ctr: number
  avgPosition: number
  keywords: Array<{ query: string, impressions: number, position: number }>
}

const props = defineProps<{
  clusters: Cluster[]
  width?: number
  height?: number
}>()

const W = computed(() => props.width ?? 920)
const H = computed(() => props.height ?? 520)

const hovered = ref<Cluster | null>(null)
const selected = ref<Cluster | null>(null)

interface Rect {
  cluster: Cluster
  x: number
  y: number
  w: number
  h: number
}

// Squarified treemap (Bruls/Huijing/Wijk 1999), simplified.
function squarify(items: Cluster[], x: number, y: number, w: number, h: number): Rect[] {
  const total = items.reduce((s, c) => s + c.totalImpressions, 0) || 1
  const rects: Rect[] = []
  let cursor = 0
  let remX = x
  let remY = y
  let remW = w
  let remH = h
  let remTotal = total

  while (cursor < items.length) {
    const horizontal = remW >= remH
    const shortSide = Math.min(remW, remH)
    const row: Cluster[] = []
    let rowSum = 0
    let bestRatio = Infinity

    while (cursor < items.length) {
      const candidate = items[cursor]!
      const newSum = rowSum + candidate.totalImpressions
      const newRatio = worstAspect(row.concat(candidate), shortSide, newSum, remTotal, remW * remH)
      if (newRatio > bestRatio && row.length > 0)
        break
      row.push(candidate)
      rowSum = newSum
      bestRatio = newRatio
      cursor++
    }

    // Lay out the row along the short side.
    const rowArea = (rowSum / remTotal) * (remW * remH)
    const rowThickness = rowArea / shortSide
    let offset = horizontal ? remY : remX
    for (const c of row) {
      const cellLength = (c.totalImpressions / rowSum) * shortSide
      if (horizontal) {
        rects.push({ cluster: c, x: remX, y: offset, w: rowThickness, h: cellLength })
      }
      else {
        rects.push({ cluster: c, x: offset, y: remY, w: cellLength, h: rowThickness })
      }
      offset += cellLength
    }
    if (horizontal) {
      remX += rowThickness
      remW -= rowThickness
    }
    else {
      remY += rowThickness
      remH -= rowThickness
    }
    remTotal -= rowSum
    if (remTotal <= 0 || remW <= 0 || remH <= 0)
      break
  }
  return rects
}

function worstAspect(row: Cluster[], shortSide: number, rowSum: number, total: number, area: number): number {
  if (rowSum <= 0 || row.length === 0)
    return Infinity
  const rowArea = (rowSum / total) * area
  const rowThickness = rowArea / shortSide
  let worst = 0
  for (const c of row) {
    const cellLength = (c.totalImpressions / rowSum) * shortSide
    const ratio = Math.max(rowThickness / cellLength, cellLength / rowThickness)
    if (ratio > worst)
      worst = ratio
  }
  return worst
}

const rects = computed(() => squarify(props.clusters, 0, 0, W.value, H.value))

// Color palette: hash cluster key → hue, saturation by ctr, lightness by position.
function colorFor(c: Cluster): string {
  let h = 0
  for (let i = 0; i < c.clusterKey.length; i++) h = (h * 31 + c.clusterKey.charCodeAt(i)) >>> 0
  const hue = h % 360
  const sat = 30 + Math.min(40, c.ctr * 200) // brighter = better CTR
  const light = 70 - Math.min(20, c.avgPosition * 1.5) // darker = better position
  return `hsl(${hue}, ${sat}%, ${light}%)`
}

function fmt(n: number): string {
  if (n >= 1000000)
    return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000)
    return `${(n / 1000).toFixed(1)}k`
  return Math.round(n).toString()
}

const detail = computed(() => selected.value ?? hovered.value ?? null)
</script>

<template>
  <div class="atlas-wrap">
    <svg :viewBox="`0 0 ${W} ${H}`" class="atlas">
      <g
        v-for="r in rects" :key="r.cluster.clusterKey"
        :transform="`translate(${r.x}, ${r.y})`"
        @mouseenter="hovered = r.cluster"
        @mouseleave="hovered = null"
        @click="selected = selected === r.cluster ? null : r.cluster"
      >
        <rect
          :width="r.w" :height="r.h"
          :fill="colorFor(r.cluster)"
          :class="{ active: detail === r.cluster }"
        />
        <text
          v-if="r.w > 70 && r.h > 28"
          :x="r.w / 2" :y="r.h / 2 - 4"
          text-anchor="middle"
          class="cluster-label"
        >
          {{ r.cluster.clusterKey }}
        </text>
        <text
          v-if="r.w > 70 && r.h > 42"
          :x="r.w / 2" :y="r.h / 2 + 11"
          text-anchor="middle"
          class="cluster-meta"
        >
          {{ r.cluster.keywordCount }} kw · {{ fmt(r.cluster.totalImpressions) }}
        </text>
      </g>
    </svg>
    <aside class="atlas-detail">
      <div v-if="detail" class="detail-pane">
        <div class="detail-key">
          {{ detail.clusterKey }}
        </div>
        <div class="detail-stats">
          <div><span>keywords</span><b>{{ detail.keywordCount }}</b></div>
          <div><span>impressions</span><b>{{ Math.round(detail.totalImpressions).toLocaleString() }}</b></div>
          <div><span>clicks</span><b>{{ Math.round(detail.totalClicks).toLocaleString() }}</b></div>
          <div><span>ctr</span><b>{{ (detail.ctr * 100).toFixed(2) }}%</b></div>
          <div><span>avg pos</span><b>{{ detail.avgPosition.toFixed(1) }}</b></div>
        </div>
        <div class="detail-list-title">
          top queries
        </div>
        <ol class="detail-list">
          <li v-for="kw in detail.keywords" :key="kw.query">
            <span class="kw">{{ kw.query }}</span>
            <span class="impr">{{ fmt(kw.impressions) }}</span>
          </li>
        </ol>
      </div>
      <div v-else class="detail-empty">
        Hover a tile to inspect its cluster.<br><br>
        Each tile is a token-cooccurrence cluster. Brighter = higher CTR, darker = better position. Tile size = total impressions.
      </div>
    </aside>
  </div>
</template>

<style scoped>
.atlas-wrap { display: grid; grid-template-columns: 1fr 280px; gap: 0; background: #0c0d14; color: #e8e8f0; border-radius: 6px; overflow: hidden; }
.atlas { display: block; width: 100%; height: auto; background: #0c0d14; }
rect { stroke: #0c0d14; stroke-width: 1.5; cursor: pointer; transition: stroke 0.15s, opacity 0.15s; }
rect.active { stroke: #fff; stroke-width: 2.5; }
g:hover rect:not(.active) { opacity: 0.85; stroke: rgba(255,255,255,0.5); }
.cluster-label { fill: #fff; font-size: 12px; font-weight: 600; pointer-events: none; font-family: ui-monospace, monospace; }
.cluster-meta { fill: rgba(255,255,255,0.7); font-size: 9.5px; pointer-events: none; font-variant-numeric: tabular-nums; }
.atlas-detail { background: #13141e; border-left: 1px solid #1d1f2e; padding: 0.75rem 0.85rem; overflow-y: auto; max-height: 520px; }
.detail-key { font-family: ui-monospace, monospace; color: #9bb3ff; font-size: 0.8rem; margin-bottom: 0.5rem; word-break: break-word; }
.detail-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 0.15rem 0.6rem; font-size: 0.72rem; color: #8b8ea5; margin-bottom: 0.75rem; }
.detail-stats > div { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
.detail-stats b { color: #e8e8f0; }
.detail-list-title { font-size: 0.65rem; letter-spacing: 0.08em; text-transform: uppercase; color: #666980; margin-bottom: 0.3rem; }
.detail-list { list-style: none; padding: 0; margin: 0; font-size: 0.72rem; }
.detail-list li { display: flex; justify-content: space-between; padding: 0.18rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); gap: 0.5rem; }
.detail-list .kw { color: #b9bccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.detail-list .impr { color: #666980; font-variant-numeric: tabular-nums; }
.detail-empty { font-size: 0.78rem; color: #8b8ea5; padding: 1.5rem 0.5rem; text-align: center; line-height: 1.5; }

@media (max-width: 800px) {
  .atlas-wrap { grid-template-columns: 1fr; }
  .atlas-detail { border-left: 0; border-top: 1px solid #1d1f2e; max-height: 320px; }
}
</style>
