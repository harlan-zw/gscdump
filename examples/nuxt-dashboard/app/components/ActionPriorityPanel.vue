<script setup lang="ts">
// Action-priority panel: ranked "what to do this week" view. Each row is a
// merged (keyword, page) action with one or more source tags, a composite
// priority score, and expandable raw-data inspection.

import type { ActionSource, Effort, PriorityAction } from '../composables/useActionPriority'

const props = defineProps<{ actions: PriorityAction[] }>()

type SortKey = 'priorityScore' | 'impact' | 'severity'

const sortKey = ref<SortKey>('priorityScore')
const activeSources = ref<Set<ActionSource>>(new Set())
const expanded = ref<Set<string>>(new Set())

const ALL_SOURCES: ActionSource[] = [
  'striking-distance',
  'opportunity',
  'cannibalization',
  'ctr-anomaly',
  'change-point',
]

const SOURCE_COLOR: Record<ActionSource, { bg: string, fg: string }> = {
  'striking-distance': { bg: '#e4f0fb', fg: '#1e5d9f' },
  'opportunity': { bg: '#e4f5ec', fg: '#2d9a6a' },
  'cannibalization': { bg: '#fce8ec', fg: '#c52d45' },
  'ctr-anomaly': { bg: '#fff3e0', fg: '#b25900' },
  'change-point': { bg: '#f2e8fc', fg: '#6a3cb2' },
}

const SOURCE_LABEL: Record<ActionSource, string> = {
  'striking-distance': 'striking',
  'opportunity': 'opportunity',
  'cannibalization': 'cannibalize',
  'ctr-anomaly': 'ctr-drop',
  'change-point': 'regression',
}

const EFFORT_COLOR: Record<Effort, { bg: string, fg: string }> = {
  low: { bg: '#e4f5ec', fg: '#2d9a6a' },
  medium: { bg: '#fff3e0', fg: '#b25900' },
  high: { bg: '#fce8ec', fg: '#c52d45' },
}

const visible = computed<PriorityAction[]>(() => {
  const filter = activeSources.value
  const rows = filter.size === 0
    ? props.actions
    : props.actions.filter(a => a.sources.some((s: ActionSource) => filter.has(s)))
  const key = sortKey.value
  return [...rows].sort((a, b) => b[key] - a[key])
})

function toggleSource(s: ActionSource): void {
  const next = new Set(activeSources.value)
  if (next.has(s))
    next.delete(s)
  else
    next.add(s)
  activeSources.value = next
}

function toggleExpand(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expanded.value = next
}

function fmt(n: number): string {
  if (!Number.isFinite(n))
    return '0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1000)
    return `${(n / 1000).toFixed(1)}k`
  return Math.round(n).toString()
}

const ORIGIN_RE = /^https?:\/\/[^/]+/
function shortUrl(u: string): string {
  const trimmed = u.replace(ORIGIN_RE, '') || '/'
  if (trimmed.length <= 44)
    return trimmed
  return `${trimmed.slice(0, 20)}…${trimmed.slice(-20)}`
}

function prettyJson(data: PriorityAction['data']): string {
  return JSON.stringify(data, (_k, v) => {
    if (typeof v === 'number' && !Number.isInteger(v))
      return Number(v.toFixed(4))
    return v
  }, 2)
}
</script>

<template>
  <div class="ap-panel">
    <div v-if="props.actions.length === 0" class="ap-empty">
      No actions yet. Run the analyzers to generate a prioritized list.
    </div>
    <template v-else>
      <div class="ap-controls">
        <div class="ap-sort">
          <span class="ap-label">sort</span>
          <button
            v-for="k in (['priorityScore', 'impact', 'severity'] as SortKey[])" :key="k"
            class="ap-seg" :class="{ active: sortKey === k }"
            @click="sortKey = k"
          >
            {{ k === 'priorityScore' ? 'priority' : k }}
          </button>
        </div>
        <div class="ap-filters">
          <span class="ap-label">filter</span>
          <button
            v-for="s in ALL_SOURCES" :key="s"
            class="ap-pill"
            :class="{ inactive: activeSources.size > 0 && !activeSources.has(s) }"
            :style="{ background: SOURCE_COLOR[s]!.bg, color: SOURCE_COLOR[s]!.fg }"
            @click="toggleSource(s)"
          >
            {{ SOURCE_LABEL[s] }}
          </button>
        </div>
      </div>

      <ol class="ap-list">
        <li
          v-for="(a, i) in visible" :key="a.id"
          class="ap-row"
          :class="{ expanded: expanded.has(a.id) }"
        >
          <div class="ap-main" @click="toggleExpand(a.id)">
            <div class="ap-rank">
              <span class="ap-rank-n">{{ i + 1 }}</span>
              <span class="ap-rank-score">{{ fmt(a.priorityScore) }}</span>
            </div>
            <div class="ap-body">
              <div class="ap-title-row">
                <span class="ap-title">{{ a.title }}</span>
                <span class="ap-effort" :style="{ background: EFFORT_COLOR[a.effort]!.bg, color: EFFORT_COLOR[a.effort]!.fg }">
                  {{ a.effort }}
                </span>
              </div>
              <div class="ap-meta">
                <span class="ap-kw">{{ a.keyword }}</span>
                <span class="ap-sep">·</span>
                <span class="ap-page" :title="a.page">{{ shortUrl(a.page) }}</span>
              </div>
              <div class="ap-why">
                {{ a.why }}
              </div>
              <div class="ap-tags">
                <span
                  v-for="s in a.sources" :key="s"
                  class="ap-tag"
                  :style="{ background: SOURCE_COLOR[s]!.bg, color: SOURCE_COLOR[s]!.fg }"
                >
                  {{ SOURCE_LABEL[s] }}
                </span>
              </div>
            </div>
            <div class="ap-stats">
              <div class="ap-stat">
                <span class="ap-stat-v">{{ fmt(a.impact) }}</span>
                <span class="ap-stat-k">impact</span>
              </div>
              <div class="ap-stat">
                <span class="ap-stat-v">{{ Math.round(a.severity) }}</span>
                <span class="ap-stat-k">severity</span>
              </div>
              <div class="ap-stat">
                <span class="ap-stat-v">{{ fmt(a.impressions) }}</span>
                <span class="ap-stat-k">impr</span>
              </div>
            </div>
          </div>
          <pre v-if="expanded.has(a.id)" class="ap-details">{{ prettyJson(a.data) }}</pre>
        </li>
      </ol>
    </template>
  </div>
</template>

<style scoped>
.ap-panel { display: flex; flex-direction: column; gap: 0.75rem; }
.ap-empty { padding: 2.5rem; text-align: center; color: #888; font-size: 0.9rem; border: 1px solid #f0f0f2; border-radius: 4px; background: #fff; }

.ap-controls { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; justify-content: space-between; padding: 0.5rem 0.25rem; }
.ap-sort, .ap-filters { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.ap-label { font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; color: #888; margin-right: 0.25rem; }
.ap-seg { background: #f4f4f6; color: #555; border: 0; padding: 0.25rem 0.6rem; font-size: 0.72rem; font-weight: 500; border-radius: 3px; cursor: pointer; font-family: inherit; }
.ap-seg.active { background: #1d1d1f; color: #fff; }
.ap-pill { border: 0; padding: 0.2rem 0.55rem; font-size: 0.7rem; font-weight: 600; border-radius: 10px; cursor: pointer; opacity: 1; font-family: inherit; transition: opacity 0.15s; }
.ap-pill.inactive { opacity: 0.35; }

.ap-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; border: 1px solid #f0f0f2; border-radius: 4px; background: #fff; max-height: 72vh; overflow-y: auto; }
.ap-row { border-bottom: 1px solid #f4f4f6; transition: background 0.15s; }
.ap-row:last-child { border-bottom: 0; }
.ap-row:hover { background: #fafafb; }
.ap-row.expanded { background: #f6f6fb; }

.ap-main { display: grid; grid-template-columns: auto 1fr auto; gap: 1rem; padding: 0.75rem 1rem; cursor: pointer; align-items: start; }
.ap-rank { display: flex; flex-direction: column; align-items: center; gap: 0.1rem; min-width: 2.5rem; padding-top: 0.15rem; }
.ap-rank-n { font-size: 1.1rem; font-weight: 700; color: #1d1d1f; font-variant-numeric: tabular-nums; line-height: 1; }
.ap-rank-score { font-size: 0.64rem; color: #888; font-variant-numeric: tabular-nums; }

.ap-body { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.ap-title-row { display: flex; align-items: center; gap: 0.5rem; }
.ap-title { font-weight: 600; font-size: 0.88rem; color: #1d1d1f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-effort { font-size: 0.6rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.1rem 0.4rem; border-radius: 3px; }
.ap-meta { font-size: 0.74rem; font-family: ui-monospace, monospace; color: #555; display: flex; gap: 0.4rem; align-items: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ap-kw { color: #1d1d1f; }
.ap-sep { color: #b9bccc; }
.ap-page { color: #6a6e85; overflow: hidden; text-overflow: ellipsis; }
.ap-why { font-size: 0.78rem; color: #555; line-height: 1.35; }
.ap-tags { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.1rem; }
.ap-tag { font-size: 0.64rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; }

.ap-stats { display: flex; gap: 0.75rem; align-items: start; padding-top: 0.2rem; }
.ap-stat { display: flex; flex-direction: column; align-items: flex-end; min-width: 3rem; }
.ap-stat-v { font-family: ui-monospace, monospace; font-size: 0.88rem; font-weight: 600; color: #1d1d1f; font-variant-numeric: tabular-nums; line-height: 1.1; }
.ap-stat-k { font-size: 0.6rem; letter-spacing: 0.06em; text-transform: uppercase; color: #888; }

.ap-details { margin: 0; padding: 0.75rem 1rem 1rem 4.25rem; background: #f6f6fb; font-family: ui-monospace, monospace; font-size: 0.7rem; color: #444; white-space: pre-wrap; word-break: break-word; max-height: 22rem; overflow-y: auto; border-top: 1px dashed #e4e4e7; }

@media (max-width: 820px) {
  .ap-main { grid-template-columns: auto 1fr; gap: 0.6rem; }
  .ap-stats { grid-column: 1 / -1; justify-content: space-between; padding: 0; }
  .ap-details { padding-left: 1rem; }
}
</style>
