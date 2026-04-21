<script setup lang="ts">
// Bipartite PageRank: personalized eigenvector centrality on the
// (query <-> url) graph. "Hub queries" bridge many URLs; "hub URLs" anchor
// many queries. Each column lists the top-ranked nodes of that kind with
// a rank bar, its bridging/anchoring count, and total impressions. Above
// both columns, a small sparkline shows L1 delta per power-iteration step
// so users can see convergence behaviour of the current dataset.

interface PageRankNode {
  kind: 'query' | 'url'
  id: string
  rank: number
  bridging: number
  anchoring: number
  degree: number
  impressions: number
}

interface ConvergencePoint {
  step: number
  l1: number
}

interface PageRankMeta {
  iterations: number
  damping: number
  convergenceDelta: number
  queryCount: number
  urlCount: number
  deltas: ConvergencePoint[]
}

const props = defineProps<{
  nodes: PageRankNode[]
  meta: PageRankMeta
}>()

const queries = computed(() =>
  props.nodes
    .filter(n => n.kind === 'query')
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 25),
)

const urls = computed(() =>
  props.nodes
    .filter(n => n.kind === 'url')
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 25),
)

const maxQueryRank = computed(() => {
  let m = 0
  for (const q of queries.value) {
    if (q.rank > m)
      m = q.rank
  }
  return m || 1
})

const maxUrlRank = computed(() => {
  let m = 0
  for (const u of urls.value) {
    if (u.rank > m)
      m = u.rank
  }
  return m || 1
})

// Convergence sparkline. x = step, y = log10(l1). Log space compresses the
// typical 3+ order-of-magnitude drop from iteration 1 to 25 into a usable
// visual range; zero/tiny values clamp to a floor so the line stays drawn.
const SPARK_W = 320
const SPARK_H = 44
const SPARK_PAD = 4

const sparkPath = computed(() => {
  const d = props.meta.deltas
  if (d.length === 0)
    return ''
  const vals = d.map(p => Math.log10(Math.max(p.l1, 1e-10)))
  const yMin = Math.min(...vals)
  const yMax = Math.max(...vals)
  const yRange = Math.max(yMax - yMin, 0.1)
  const xStep = (SPARK_W - SPARK_PAD * 2) / Math.max(d.length - 1, 1)
  return d.map((p, i) => {
    const x = SPARK_PAD + i * xStep
    const y = SPARK_PAD + (1 - (Math.log10(Math.max(p.l1, 1e-10)) - yMin) / yRange) * (SPARK_H - SPARK_PAD * 2)
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
})

const ORIGIN_RE = /^https?:\/\/[^/]+/

function shortUrl(u: string): string {
  const trimmed = u.replace(ORIGIN_RE, '')
  if (trimmed.length <= 44)
    return trimmed || '/'
  return `…${trimmed.slice(-42)}`
}

function fmtRank(v: number): string {
  return v.toFixed(4)
}

function fmtImpressions(v: number): string {
  if (v >= 1e6)
    return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3)
    return `${(v / 1e3).toFixed(1)}K`
  return String(Math.round(v))
}

function fmtDelta(v: number): string {
  if (v === 0)
    return '0'
  if (v < 1e-4)
    return v.toExponential(1)
  return v.toFixed(4)
}
</script>

<template>
  <div class="pr-wrap">
    <div class="pr-head">
      <div class="pr-title">
        Bipartite PageRank
      </div>
      <div class="pr-stats">
        <span><b>{{ meta.queryCount }}</b> queries</span>
        <span><b>{{ meta.urlCount }}</b> urls</span>
        <span><b>{{ meta.iterations }}</b> iters</span>
        <span>d = <b>{{ meta.damping.toFixed(2) }}</b></span>
        <span>Δ<sub>final</sub> = <b>{{ fmtDelta(meta.convergenceDelta) }}</b></span>
      </div>
      <div class="pr-spark-wrap">
        <svg :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`" class="pr-spark">
          <path :d="sparkPath" class="pr-spark-line" />
        </svg>
        <div class="pr-spark-label">
          L1 delta per iter (log₁₀)
        </div>
      </div>
    </div>

    <div class="pr-grid">
      <section class="pr-col">
        <header class="pr-col-head">
          <div class="pr-col-title">
            Hub queries
          </div>
          <div class="pr-col-hint">
            bridge many URLs
          </div>
        </header>
        <ol class="pr-list">
          <li v-for="(q, i) in queries" :key="q.id" class="pr-row">
            <div class="pr-rank">
              {{ i + 1 }}
            </div>
            <div class="pr-body">
              <div class="pr-id" :title="q.id">
                {{ q.id }}
              </div>
              <div class="pr-bar-track">
                <div
                  class="pr-bar pr-bar-q"
                  :style="{ width: `${(q.rank / maxQueryRank) * 100}%` }"
                />
              </div>
              <div class="pr-meta">
                <span>rank <b>{{ fmtRank(q.rank) }}</b></span>
                <span>bridges <b>{{ q.bridging }}</b> urls</span>
                <span>{{ fmtImpressions(q.impressions) }} impr</span>
              </div>
            </div>
          </li>
          <li v-if="queries.length === 0" class="pr-empty">
            No hub queries at the current threshold.
          </li>
        </ol>
      </section>

      <section class="pr-col">
        <header class="pr-col-head">
          <div class="pr-col-title">
            Hub URLs
          </div>
          <div class="pr-col-hint">
            anchor many queries
          </div>
        </header>
        <ol class="pr-list">
          <li v-for="(u, i) in urls" :key="u.id" class="pr-row">
            <div class="pr-rank">
              {{ i + 1 }}
            </div>
            <div class="pr-body">
              <div class="pr-id pr-id-mono" :title="u.id">
                {{ shortUrl(u.id) }}
              </div>
              <div class="pr-bar-track">
                <div
                  class="pr-bar pr-bar-u"
                  :style="{ width: `${(u.rank / maxUrlRank) * 100}%` }"
                />
              </div>
              <div class="pr-meta">
                <span>rank <b>{{ fmtRank(u.rank) }}</b></span>
                <span>anchors <b>{{ u.anchoring }}</b> queries</span>
                <span>{{ fmtImpressions(u.impressions) }} impr</span>
              </div>
            </div>
          </li>
          <li v-if="urls.length === 0" class="pr-empty">
            No hub URLs at the current threshold.
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pr-wrap { background: #0c0d14; color: #e8e8f0; border-radius: 6px; overflow: hidden; border: 1px solid #1d1f2e; }
.pr-head { padding: 0.7rem 0.9rem; border-bottom: 1px solid #1d1f2e; display: grid; grid-template-columns: auto 1fr auto; gap: 0.8rem; align-items: center; background: #13141e; }
.pr-title { font-size: 0.82rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #b9bccc; }
.pr-stats { display: flex; gap: 0.9rem; font-size: 0.72rem; color: #8b8ea5; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.pr-stats b { color: #e8e8f0; font-weight: 600; }
.pr-stats sub { font-size: 0.55rem; }
.pr-spark-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem; }
.pr-spark { width: 320px; height: 44px; background: #0c0d14; border-radius: 3px; }
.pr-spark-line { fill: none; stroke: #6a7cc8; stroke-width: 1.4; }
.pr-spark-label { font-size: 0.62rem; color: #8b8ea5; letter-spacing: 0.04em; text-transform: uppercase; }

.pr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.pr-col { padding: 0.7rem 0; min-width: 0; }
.pr-col + .pr-col { border-left: 1px solid #1d1f2e; }
.pr-col-head { padding: 0 0.9rem 0.45rem; display: flex; align-items: baseline; justify-content: space-between; }
.pr-col-title { font-size: 0.74rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: #b9bccc; }
.pr-col-hint { font-size: 0.64rem; color: #8b8ea5; }

.pr-list { list-style: none; padding: 0; margin: 0; max-height: 520px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #2a2d40 transparent; }
.pr-list::-webkit-scrollbar { width: 6px; }
.pr-list::-webkit-scrollbar-thumb { background: #2a2d40; border-radius: 3px; }

.pr-row { display: grid; grid-template-columns: 22px 1fr; gap: 0.45rem; padding: 0.45rem 0.9rem; border-top: 1px solid #14151f; align-items: start; }
.pr-row:first-child { border-top: 0; }
.pr-rank { font-family: ui-monospace, monospace; font-size: 0.7rem; color: #6a6d85; text-align: right; padding-top: 2px; font-variant-numeric: tabular-nums; }
.pr-body { min-width: 0; }
.pr-id { font-size: 0.82rem; color: #e8e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-id-mono { font-family: ui-monospace, monospace; font-size: 0.76rem; color: #b9bccc; }
.pr-bar-track { height: 5px; background: #14151f; border-radius: 2px; margin: 0.35rem 0 0.3rem; overflow: hidden; }
.pr-bar { height: 100%; border-radius: 2px; transition: width 0.25s ease; }
.pr-bar-q { background: linear-gradient(90deg, #6a7cc8, #8a9ae0); }
.pr-bar-u { background: linear-gradient(90deg, #3cc28a, #5fdba1); }
.pr-meta { display: flex; gap: 0.75rem; font-size: 0.68rem; color: #8b8ea5; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.pr-meta b { color: #e8e8f0; font-weight: 600; }

.pr-empty { padding: 1.2rem 0.9rem; font-size: 0.78rem; color: #8b8ea5; text-align: center; }

@media (max-width: 880px) {
  .pr-grid { grid-template-columns: 1fr; }
  .pr-col + .pr-col { border-left: 0; border-top: 1px solid #1d1f2e; }
  .pr-head { grid-template-columns: 1fr; }
  .pr-spark-wrap { align-items: flex-start; }
}
</style>
