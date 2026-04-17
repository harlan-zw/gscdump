<script setup lang="ts">
// Sankey-style flow: left column = source URLs (lost queries), right column =
// target URLs (gained queries that fuzzy-match). Edge thickness = absorbed
// impressions. Hover an edge to see the matched query pairs.

interface Example {
  sourceQuery: string
  targetQuery: string
  absorbed: number
  matchType: 'exact' | 'fuzzy'
}

interface Edge {
  sourcePage: string
  targetPage: string
  weight: number
  queryCount: number
  exactCount: number
  fuzzyCount: number
  examples: Example[]
}

interface NodeRow {
  url: string
  outgoing: number
  incoming: number
}

const props = defineProps<{
  edges: Edge[]
  nodes: NodeRow[]
}>()

const W = 920
const H = 540
const NODE_W = 14
const PAD_TOP = 24
const PAD_BOT = 24
const NODE_GAP = 4

const hovered = ref<Edge | null>(null)

// Split nodes into source (outgoing>0) and target (incoming>0) columns.
// A node may appear in both if it both lost and gained.
interface PositionedNode {
  url: string
  side: 'source' | 'target'
  y: number
  height: number
  weight: number
}

const layout = computed(() => {
  const sources = props.nodes
    .filter(n => n.outgoing > 0)
    .sort((a, b) => b.outgoing - a.outgoing)
  const targets = props.nodes
    .filter(n => n.incoming > 0)
    .sort((a, b) => b.incoming - a.incoming)

  const sourceTotal = sources.reduce((s, n) => s + n.outgoing, 0) || 1
  const targetTotal = targets.reduce((s, n) => s + n.incoming, 0) || 1
  const verticalSpace = H - PAD_TOP - PAD_BOT - Math.max(sources.length - 1, 0) * NODE_GAP
  const verticalSpaceR = H - PAD_TOP - PAD_BOT - Math.max(targets.length - 1, 0) * NODE_GAP

  const sourceMap = new Map<string, PositionedNode>()
  const targetMap = new Map<string, PositionedNode>()

  let y = PAD_TOP
  for (const n of sources) {
    const height = Math.max(2, (n.outgoing / sourceTotal) * verticalSpace)
    sourceMap.set(n.url, { url: n.url, side: 'source', y, height, weight: n.outgoing })
    y += height + NODE_GAP
  }

  y = PAD_TOP
  for (const n of targets) {
    const height = Math.max(2, (n.incoming / targetTotal) * verticalSpaceR)
    targetMap.set(n.url, { url: n.url, side: 'target', y, height, weight: n.incoming })
    y += height + NODE_GAP
  }

  // Position edges: each edge takes a vertical slice on each side proportional
  // to its weight relative to the parent node.
  interface PositionedEdge {
    edge: Edge
    src: PositionedNode
    tgt: PositionedNode
    sy0: number
    sy1: number
    ty0: number
    ty1: number
  }

  // Track running offsets per node side to stack edges.
  const sourceOffset = new Map<string, number>()
  const targetOffset = new Map<string, number>()
  const positioned: PositionedEdge[] = []

  // Stack edges in weight-descending order so heaviest land on top.
  const sorted = [...props.edges].sort((a, b) => b.weight - a.weight)
  for (const e of sorted) {
    const src = sourceMap.get(e.sourcePage)
    const tgt = targetMap.get(e.targetPage)
    if (src == null || tgt == null)
      continue
    const sShare = (e.weight / src.weight) * src.height
    const tShare = (e.weight / tgt.weight) * tgt.height
    const sStart = (sourceOffset.get(e.sourcePage) ?? 0)
    const tStart = (targetOffset.get(e.targetPage) ?? 0)
    sourceOffset.set(e.sourcePage, sStart + sShare)
    targetOffset.set(e.targetPage, tStart + tShare)
    positioned.push({
      edge: e,
      src,
      tgt,
      sy0: src.y + sStart,
      sy1: src.y + sStart + sShare,
      ty0: tgt.y + tStart,
      ty1: tgt.y + tStart + tShare,
    })
  }

  return { sources: [...sourceMap.values()], targets: [...targetMap.values()], edges: positioned }
})

const SRC_X = 130
const TGT_X = W - 130 - NODE_W

function bezierBand(sy0: number, sy1: number, ty0: number, ty1: number): string {
  const x0 = SRC_X + NODE_W
  const x1 = TGT_X
  const cx0 = x0 + (x1 - x0) * 0.45
  const cx1 = x1 - (x1 - x0) * 0.45
  return `M ${x0},${sy0} C ${cx0},${sy0} ${cx1},${ty0} ${x1},${ty0} L ${x1},${ty1} C ${cx1},${ty1} ${cx0},${sy1} ${x0},${sy1} Z`
}

const ORIGIN_RE = /^https?:\/\/[^/]+/

function shortUrl(u: string): string {
  const trimmed = u.replace(ORIGIN_RE, '')
  if (trimmed.length <= 22)
    return trimmed || '/'
  return `…${trimmed.slice(-20)}`
}

function fmt(n: number): string {
  if (n >= 1000000)
    return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000)
    return `${(n / 1000).toFixed(1)}k`
  return Math.round(n).toString()
}
</script>

<template>
  <div class="sankey-wrap">
    <svg :viewBox="`0 0 ${W} ${H}`" class="sankey">
      <text :x="SRC_X" :y="14" class="col-head">
        lost from (prev period)
      </text>
      <text :x="TGT_X + NODE_W" :y="14" text-anchor="end" class="col-head">
        gained by (current period)
      </text>

      <!-- edges (bezier ribbons) -->
      <g class="edges">
        <path
          v-for="(e, i) in layout.edges" :key="i"
          :d="bezierBand(e.sy0, e.sy1, e.ty0, e.ty1)"
          :class="{ active: hovered === e.edge }"
          @mouseenter="hovered = e.edge"
          @mouseleave="hovered = null"
        />
      </g>

      <!-- nodes -->
      <g class="nodes">
        <g v-for="n in layout.sources" :key="`s-${n.url}`">
          <rect :x="SRC_X" :y="n.y" :width="NODE_W" :height="n.height" class="node" />
          <text :x="SRC_X - 6" :y="n.y + n.height / 2 + 3" text-anchor="end" class="node-label">
            {{ shortUrl(n.url) }}
          </text>
        </g>
        <g v-for="n in layout.targets" :key="`t-${n.url}`">
          <rect :x="TGT_X" :y="n.y" :width="NODE_W" :height="n.height" class="node" />
          <text :x="TGT_X + NODE_W + 6" :y="n.y + n.height / 2 + 3" class="node-label">
            {{ shortUrl(n.url) }}
          </text>
        </g>
      </g>
    </svg>

    <aside class="sankey-detail">
      <div v-if="hovered" class="detail-pane">
        <div class="route">
          <div class="route-side">
            <div class="route-label">
              from
            </div>
            <div class="route-url">
              {{ hovered.sourcePage }}
            </div>
          </div>
          <div class="route-arrow">
            →
          </div>
          <div class="route-side">
            <div class="route-label">
              to
            </div>
            <div class="route-url">
              {{ hovered.targetPage }}
            </div>
          </div>
        </div>
        <div class="detail-stats">
          <div><span>absorbed impressions</span><b>{{ Math.round(hovered.weight).toLocaleString() }}</b></div>
          <div><span>queries</span><b>{{ hovered.queryCount }}</b></div>
          <div><span>exact / fuzzy</span><b>{{ hovered.exactCount }} / {{ hovered.fuzzyCount }}</b></div>
        </div>
        <div class="detail-list-title">
          example query pairs
        </div>
        <ul class="example-list">
          <li v-for="(ex, i) in hovered.examples" :key="i">
            <div class="ex-pair">
              <span class="ex-q ex-from">{{ ex.sourceQuery }}</span>
              <span class="ex-arrow">→</span>
              <span class="ex-q ex-to">{{ ex.targetQuery }}</span>
            </div>
            <div class="ex-meta">
              <span class="ex-tag" :class="[`ex-tag-${ex.matchType}`]">{{ ex.matchType }}</span>
              <span>{{ fmt(ex.absorbed) }}</span>
            </div>
          </li>
        </ul>
      </div>
      <div v-else class="detail-empty">
        Hover an edge to see the migrating queries.<br><br>
        Edges are matched via exact equality or DuckDB's <code>levenshtein()</code> ≤ 2 — queries that almost survived but landed on a different URL.
      </div>
    </aside>
  </div>
</template>

<style scoped>
.sankey-wrap { display: grid; grid-template-columns: 1fr 320px; gap: 0; background: #0c0d14; color: #e8e8f0; border-radius: 6px; overflow: hidden; }
.sankey { display: block; width: 100%; height: auto; background: linear-gradient(180deg, #0c0d14 0%, #14152a 100%); }
.col-head { fill: #8b8ea5; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; font-family: ui-monospace, monospace; }
.edges path { fill: rgba(106, 124, 200, 0.25); stroke: none; cursor: pointer; transition: fill 0.15s; }
.edges path:hover, .edges path.active { fill: rgba(232, 72, 96, 0.7); }
.node { fill: #6a7cc8; stroke: rgba(255,255,255,0.15); stroke-width: 0.5; }
.node-label { fill: #b9bccc; font-size: 10px; font-family: ui-monospace, monospace; pointer-events: none; }
.sankey-detail { background: #13141e; border-left: 1px solid #1d1f2e; padding: 0.75rem 0.85rem; overflow-y: auto; max-height: 540px; }
.route { display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.5rem; align-items: center; margin-bottom: 0.6rem; }
.route-label { font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; color: #666980; }
.route-url { font-family: ui-monospace, monospace; font-size: 0.7rem; color: #9bb3ff; word-break: break-all; line-height: 1.3; }
.route-arrow { color: #ff7788; font-size: 1.1rem; font-weight: 600; }
.detail-stats { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.72rem; color: #8b8ea5; margin-bottom: 0.7rem; }
.detail-stats > div { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
.detail-stats b { color: #e8e8f0; }
.detail-list-title { font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; color: #666980; margin-bottom: 0.3rem; }
.example-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.example-list li { padding: 0.4rem 0.5rem; background: rgba(255,255,255,0.025); border-radius: 4px; font-size: 0.72rem; }
.ex-pair { display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
.ex-q { font-family: ui-monospace, monospace; }
.ex-from { color: #ff9bb3; }
.ex-to { color: #9bb3ff; }
.ex-arrow { color: #666980; }
.ex-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 0.25rem; font-size: 0.65rem; color: #666980; font-variant-numeric: tabular-nums; }
.ex-tag { font-size: 0.6rem; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.05rem 0.3rem; border-radius: 3px; }
.ex-tag-exact { background: rgba(60, 194, 138, 0.15); color: #3cc28a; }
.ex-tag-fuzzy { background: rgba(255, 155, 179, 0.15); color: #ff9bb3; }
.detail-empty { font-size: 0.78rem; color: #8b8ea5; padding: 1.5rem 0.5rem; text-align: center; line-height: 1.55; }
.detail-empty code { background: rgba(255,255,255,0.06); padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.72rem; color: #b9bccc; }

@media (max-width: 800px) {
  .sankey-wrap { grid-template-columns: 1fr; }
  .sankey-detail { border-left: 0; border-top: 1px solid #1d1f2e; max-height: 320px; }
}
</style>
