<script setup lang="ts">
// Force-directed SVG graph for the cannibalization analyzer output.
// Pure client-side: runs a tiny Verlet-ish simulator (repulsion + spring +
// centering) over the meta.graph nodes/edges emitted by buildCannibalization.
//
// Node radius ~ sqrt(impressions). Edge stroke ~ log(weight). Top-severity
// event's URLs are highlighted red; hovering any node shows its metrics.

interface GraphNode {
  url: string
  impressions: number
  clicks: number
  queryCount: number
}

interface GraphEdge {
  source: string
  target: string
  weight: number
  queries: number
}

interface CannibalEvent {
  keyword: string
  competitors: Array<{ url: string, rank: number }>
  severity: number
}

const props = defineProps<{
  nodes: GraphNode[]
  edges: GraphEdge[]
  events: CannibalEvent[]
}>()

interface SimNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

const WIDTH = 920
const HEIGHT = 520
const ITERATIONS = 300

const hoverUrl = ref<string | null>(null)
const selectedQuery = ref<string | null>(null)

// URLs competing in the top (most severe) event — painted red.
const hotUrls = computed(() => {
  if (selectedQuery.value) {
    const ev = props.events.find(e => e.keyword === selectedQuery.value)
    return new Set(ev?.competitors.map(c => c.url) ?? [])
  }
  const top = [...props.events].sort((a, b) => b.severity - a.severity)[0]
  return new Set(top?.competitors.map(c => c.url) ?? [])
})

const sim = computed(() => {
  if (props.nodes.length === 0)
    return { nodes: [] as SimNode[], edges: [] as Array<{ a: SimNode, b: SimNode, w: number }> }

  const maxImpr = Math.max(...props.nodes.map(n => n.impressions), 1)
  const nodeMap = new Map<string, SimNode>()
  const initial: SimNode[] = props.nodes.map((n, i) => {
    const angle = (i / props.nodes.length) * Math.PI * 2
    const r = 4 + Math.sqrt(n.impressions / maxImpr) * 22
    const node: SimNode = {
      ...n,
      x: WIDTH / 2 + Math.cos(angle) * 150,
      y: HEIGHT / 2 + Math.sin(angle) * 150,
      vx: 0,
      vy: 0,
      r,
    }
    nodeMap.set(n.url, node)
    return node
  })

  const edgeList = props.edges
    .map(e => ({
      a: nodeMap.get(e.source)!,
      b: nodeMap.get(e.target)!,
      w: e.weight,
    }))
    .filter(e => e.a != null && e.b != null)

  const maxEdgeW = Math.max(...edgeList.map(e => e.w), 1)

  // Simulate.
  const repulsionK = 2400
  const centerK = 0.015
  const damping = 0.82
  const idealLen = 140

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion (O(n²) — fine for ≤ few hundred nodes).
    for (let i = 0; i < initial.length; i++) {
      for (let j = i + 1; j < initial.length; j++) {
        const a = initial[i]!
        const b = initial[j]!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist2 = dx * dx + dy * dy + 1
        const force = repulsionK / dist2
        const dist = Math.sqrt(dist2)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx -= fx
        a.vy -= fy
        b.vx += fx
        b.vy += fy
      }
    }
    // Spring attraction along edges; stronger springs for heavier edges.
    for (const e of edgeList) {
      const dx = e.b.x - e.a.x
      const dy = e.b.y - e.a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const strength = 0.04 * (0.3 + 0.7 * (e.w / maxEdgeW))
      const disp = (dist - idealLen) * strength
      const fx = (dx / dist) * disp
      const fy = (dy / dist) * disp
      e.a.vx += fx
      e.a.vy += fy
      e.b.vx -= fx
      e.b.vy -= fy
    }
    // Centering + integrate.
    for (const n of initial) {
      n.vx += (WIDTH / 2 - n.x) * centerK
      n.vy += (HEIGHT / 2 - n.y) * centerK
      n.vx *= damping
      n.vy *= damping
      n.x += n.vx
      n.y += n.vy
      // Keep inside the viewbox.
      n.x = Math.max(n.r + 2, Math.min(WIDTH - n.r - 2, n.x))
      n.y = Math.max(n.r + 2, Math.min(HEIGHT - n.r - 2, n.y))
    }
  }

  return { nodes: initial, edges: edgeList, maxEdgeW }
})

const ORIGIN_RE = /^https?:\/\/[^/]+/

function shortenUrl(url: string): string {
  const trimmed = url.replace(ORIGIN_RE, '')
  if (trimmed.length <= 28)
    return trimmed || '/'
  return `${trimmed.slice(0, 14)}…${trimmed.slice(-12)}`
}

function fmt(n: number): string {
  if (n >= 1000000)
    return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000)
    return `${(n / 1000).toFixed(1)}k`
  return Math.round(n).toString()
}

const hovered = computed(() => sim.value.nodes.find(n => n.url === hoverUrl.value) ?? null)
const topEvents = computed(() => [...props.events].sort((a, b) => b.severity - a.severity).slice(0, 8))
</script>

<template>
  <div class="canvas-wrap">
    <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" class="graph">
      <!-- edges -->
      <g class="edges">
        <line
          v-for="(e, i) in sim.edges" :key="i"
          :x1="e.a.x" :y1="e.a.y" :x2="e.b.x" :y2="e.b.y"
          :stroke-width="0.6 + Math.log10(1 + e.w) * 0.9"
          :stroke="hotUrls.has(e.a.url) && hotUrls.has(e.b.url) ? 'rgba(220, 60, 80, 0.55)' : 'rgba(90, 90, 120, 0.22)'"
        />
      </g>
      <!-- nodes -->
      <g class="nodes">
        <g
          v-for="n in sim.nodes" :key="n.url"
          :transform="`translate(${n.x}, ${n.y})`"
          @mouseenter="hoverUrl = n.url"
          @mouseleave="hoverUrl = null"
        >
          <circle
            :r="n.r"
            :class="{ hot: hotUrls.has(n.url), hover: hoverUrl === n.url }"
          />
          <text
            v-if="n.r > 10 || hoverUrl === n.url"
            :y="n.r + 11"
            text-anchor="middle"
            class="label"
          >
            {{ shortenUrl(n.url) }}
          </text>
        </g>
      </g>
    </svg>

    <div v-if="hovered" class="tip">
      <div class="tip-url">
        {{ hovered.url }}
      </div>
      <div class="tip-row">
        <span>impressions</span><b>{{ fmt(hovered.impressions) }}</b>
      </div>
      <div class="tip-row">
        <span>clicks</span><b>{{ fmt(hovered.clicks) }}</b>
      </div>
      <div class="tip-row">
        <span>contested queries</span><b>{{ hovered.queryCount }}</b>
      </div>
    </div>

    <aside class="leaderboard">
      <h4>Worst offenders</h4>
      <ol>
        <li
          v-for="ev in topEvents" :key="ev.keyword"
          :class="{ active: selectedQuery === ev.keyword }"
          @click="selectedQuery = selectedQuery === ev.keyword ? null : ev.keyword"
        >
          <span class="sev">{{ Math.round(ev.severity) }}</span>
          <span class="kw">{{ ev.keyword }}</span>
          <span class="dim">{{ ev.competitors.length }} urls</span>
        </li>
      </ol>
      <p v-if="selectedQuery" class="hint">
        click again to clear
      </p>
      <p v-else class="hint dim">
        click a query to highlight its URLs
      </p>
    </aside>
  </div>
</template>

<style scoped>
.canvas-wrap { position: relative; display: grid; grid-template-columns: 1fr 240px; gap: 0; background: #0c0d14; color: #e8e8f0; border-radius: 8px; overflow: hidden; }
.graph { width: 100%; height: auto; display: block; background: radial-gradient(circle at 40% 40%, #181a28 0%, #0a0b12 70%); }
.edges line { transition: stroke 0.2s; }
.nodes circle { fill: #6a7cc8; stroke: #0c0d14; stroke-width: 1.5; cursor: pointer; transition: fill 0.15s, stroke 0.15s; }
.nodes circle.hot { fill: #e84860; }
.nodes circle.hover { stroke: #fff; stroke-width: 2.5; }
.nodes .label { fill: #b9bccc; font-size: 9px; font-family: ui-monospace, monospace; pointer-events: none; }
.tip { position: absolute; top: 12px; left: 12px; background: rgba(20, 22, 34, 0.96); border: 1px solid #2a2d42; padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.75rem; min-width: 200px; backdrop-filter: blur(4px); }
.tip-url { font-family: ui-monospace, monospace; color: #9bb3ff; margin-bottom: 0.4rem; word-break: break-all; }
.tip-row { display: flex; justify-content: space-between; gap: 1rem; margin: 0.15rem 0; color: #a0a0b5; }
.tip-row b { color: #e8e8f0; font-variant-numeric: tabular-nums; }
.leaderboard { padding: 0.75rem 0.85rem; background: #13141e; border-left: 1px solid #1d1f2e; overflow-y: auto; max-height: 520px; }
.leaderboard h4 { margin: 0 0 0.5rem; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b8ea5; font-weight: 600; }
.leaderboard ol { list-style: none; padding: 0; margin: 0; }
.leaderboard li { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.4rem; border-radius: 4px; cursor: pointer; font-size: 0.78rem; }
.leaderboard li:hover { background: #1d1f2e; }
.leaderboard li.active { background: #2a1a22; color: #ffb0bd; }
.leaderboard .sev { font-family: ui-monospace, monospace; font-weight: 600; color: #ff7788; min-width: 1.5rem; text-align: right; font-variant-numeric: tabular-nums; }
.leaderboard .kw { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.leaderboard .dim { color: #666980; font-size: 0.7rem; font-variant-numeric: tabular-nums; }
.leaderboard .hint { font-size: 0.7rem; color: #8b8ea5; margin: 0.5rem 0 0; }
.leaderboard .hint.dim { color: #5a5d72; font-style: italic; }

@media (max-width: 720px) {
  .canvas-wrap { grid-template-columns: 1fr; }
  .leaderboard { border-left: 0; border-top: 1px solid #1d1f2e; max-height: 240px; }
}
</style>
