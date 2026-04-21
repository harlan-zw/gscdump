<script setup lang="ts">
// Each row shows a query, its current ranking URL, and the URL that the
// embedding model says would be a better semantic match. The bar visualizes
// the cosine-similarity gap — dark left = current, bright right = suggested.

interface Alternative { url: string, similarity: number }

interface ContentGapResult {
  query: string
  impressions: number
  clicks: number
  avgPosition: number
  currentUrl: string
  currentSimilarity: number
  suggestedUrl: string
  suggestedSimilarity: number
  alternatives: Alternative[]
  divergence: number
  impact: number
}

const props = defineProps<{ rows: ContentGapResult[] }>()

const ORIGIN_RE = /^https?:\/\/[^/]+/

function shortUrl(u: string): string {
  const trimmed = u.replace(ORIGIN_RE, '')
  if (trimmed.length <= 40)
    return trimmed || '/'
  return `${trimmed.slice(0, 18)}…${trimmed.slice(-20)}`
}

function fmt(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000)
    return `${(n / 1000).toFixed(1)}k`
  return Math.round(n).toString()
}

const expanded = ref<Set<string>>(new Set())

function toggle(q: string): void {
  if (expanded.value.has(q))
    expanded.value.delete(q)
  else
    expanded.value.add(q)
  expanded.value = new Set(expanded.value)
}
</script>

<template>
  <div v-if="props.rows.length === 0" class="gap-empty">
    No content gaps detected.
  </div>
  <div v-else class="gap-list">
    <div
      v-for="r in props.rows" :key="r.query"
      class="gap-row"
      :class="{ expanded: expanded.has(r.query) }"
      @click="toggle(r.query)"
    >
      <div class="gap-main">
        <div class="gap-query">
          <span class="q">{{ r.query }}</span>
          <span class="q-meta">
            {{ fmt(r.impressions) }} impr · pos {{ r.avgPosition.toFixed(1) }}
          </span>
        </div>

        <div class="gap-urls">
          <div class="url-row url-current">
            <span class="url-label">currently ranks</span>
            <span class="url-val" :title="r.currentUrl">{{ shortUrl(r.currentUrl) }}</span>
            <span class="sim-pill sim-weak">{{ (r.currentSimilarity * 100).toFixed(0) }}</span>
          </div>
          <div class="url-row url-suggested">
            <span class="url-label">should rank</span>
            <span class="url-val" :title="r.suggestedUrl">{{ shortUrl(r.suggestedUrl) }}</span>
            <span class="sim-pill sim-strong">{{ (r.suggestedSimilarity * 100).toFixed(0) }}</span>
          </div>
        </div>

        <!-- cosine bar: current vs suggested -->
        <div class="gap-bar" :aria-label="`divergence ${(r.divergence * 100).toFixed(0)}`">
          <div class="bar-track">
            <div class="bar-current" :style="{ width: `${Math.max(2, r.currentSimilarity * 100)}%` }" />
            <div class="bar-delta" :style="{ left: `${Math.max(2, r.currentSimilarity * 100)}%`, width: `${Math.max(0, r.divergence * 100)}%` }" />
          </div>
          <span class="bar-label">Δ {{ (r.divergence * 100).toFixed(0) }}</span>
        </div>
      </div>

      <div v-if="expanded.has(r.query)" class="gap-alts">
        <div class="alts-title">
          runner-up semantic matches
        </div>
        <ol>
          <li v-for="a in r.alternatives" :key="a.url">
            <span class="alt-sim">{{ (a.similarity * 100).toFixed(0) }}</span>
            <span class="alt-url">{{ shortUrl(a.url) }}</span>
          </li>
        </ol>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gap-empty { padding: 2.5rem; text-align: center; color: #888; font-size: 0.9rem; }
.gap-list { display: flex; flex-direction: column; gap: 0; max-height: 72vh; overflow-y: auto; border: 1px solid #f0f0f2; border-radius: 4px; background: #fff; }
.gap-row { padding: 0.75rem 1rem; border-bottom: 1px solid #f4f4f6; cursor: pointer; transition: background 0.15s; }
.gap-row:hover { background: #fafafb; }
.gap-row.expanded { background: #f6f6fb; }
.gap-row:last-child { border-bottom: 0; }
.gap-main { display: grid; grid-template-columns: 1.2fr 2fr 1fr; gap: 1rem; align-items: center; }
.gap-query { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.gap-query .q { font-weight: 600; font-size: 0.88rem; color: #1d1d1f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gap-query .q-meta { font-size: 0.72rem; color: #888; font-variant-numeric: tabular-nums; }

.gap-urls { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.url-row { display: grid; grid-template-columns: auto 1fr auto; gap: 0.5rem; align-items: center; font-size: 0.76rem; }
.url-label { font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; color: #888; white-space: nowrap; }
.url-val { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.url-current .url-val { color: #c52d45; }
.url-suggested .url-val { color: #2d9a6a; }
.sim-pill { font-family: ui-monospace, monospace; font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; font-variant-numeric: tabular-nums; }
.sim-weak { background: #fce8ec; color: #c52d45; }
.sim-strong { background: #e4f5ec; color: #2d9a6a; }

.gap-bar { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.bar-track { position: relative; height: 10px; flex: 1; background: #ececef; border-radius: 5px; overflow: hidden; }
.bar-current { position: absolute; left: 0; top: 0; bottom: 0; background: #c52d45; }
.bar-delta { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(45deg, #2d9a6a 0 4px, #3cc28a 4px 8px); }
.bar-label { font-size: 0.72rem; font-weight: 600; color: #2d9a6a; font-variant-numeric: tabular-nums; white-space: nowrap; }

.gap-alts { margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px dashed #e4e4e7; }
.alts-title { font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; color: #888; margin-bottom: 0.3rem; }
.gap-alts ol { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.gap-alts li { display: flex; gap: 0.6rem; align-items: center; font-size: 0.76rem; }
.alt-sim { font-family: ui-monospace, monospace; font-size: 0.68rem; color: #6a6e85; min-width: 2rem; text-align: right; font-variant-numeric: tabular-nums; }
.alt-url { font-family: ui-monospace, monospace; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 820px) {
  .gap-main { grid-template-columns: 1fr; gap: 0.5rem; }
}
</style>
