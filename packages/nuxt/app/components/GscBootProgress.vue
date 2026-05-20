<script setup lang="ts">
// Minimal boot-progress indicator for the browser-side DuckDB-WASM + parquet
// attach flow. Reads per-site progress straight off the injected analyzer
// state (`siteProgress` on `BrowserAnalyzerState`) — no derived composable,
// no prop drilling.
//
// Collapsed view: one slim stacked bar, each segment a site, coloured by
// stage. Tap to expand per-site rows with file counters. Hidden once every
// tracked site is ready.

import type { SiteLoadProgress, SiteLoadStage } from '../composables/useGscAnalytics'
import { useGscBootProgress } from '../composables/useGscAnalytics'

// Reads the shared per-site progress ref directly. Both DuckDB boot and rollup
// fan-out write to it, so this component lights up for either flow without
// caring who's producing the signal.
const { progress: siteProgress } = useGscBootProgress()

const expanded = ref(false)

const sites = computed<SiteLoadProgress[]>(() =>
  Object.values(siteProgress.value).sort((a, b) => a.startedAt - b.startedAt),
)

const allReady = computed(() => sites.value.length > 0 && sites.value.every(s => s.stage === 'ready'))
const anyActive = computed(() => sites.value.some(s => s.stage !== 'ready' && s.stage !== 'idle' && s.stage !== 'error'))

const aggregate = computed(() => {
  let attached = 0
  let total = 0
  for (const s of sites.value) {
    attached += s.filesAttached
    total += s.filesTotal
  }
  return { attached, total, pct: total > 0 ? Math.round((attached / total) * 100) : 0 }
})

// Rank stages so the earliest-stage site drives the overall headline.
const stageRank: Record<SiteLoadStage, number> = {
  idle: 0,
  wasm: 1,
  manifest: 2,
  attach: 3,
  ready: 4,
  error: -1,
}

const earliestStage = computed<SiteLoadStage>(() => {
  let min: SiteLoadStage = 'ready'
  let minRank = stageRank.ready
  for (const s of sites.value) {
    const r = stageRank[s.stage]
    if (r >= 0 && r < minRank) {
      min = s.stage
      minRank = r
    }
  }
  return min
})

const stageLabel: Record<SiteLoadStage, string> = {
  idle: 'Queued',
  wasm: 'Starting DuckDB',
  manifest: 'Fetching manifest',
  attach: 'Attaching parquet',
  ready: 'Ready',
  error: 'Error',
}

const stageColor: Record<SiteLoadStage, string> = {
  idle: 'bg-neutral-700',
  wasm: 'bg-violet-500',
  manifest: 'bg-sky-500',
  attach: 'bg-emerald-500',
  ready: 'bg-emerald-600',
  error: 'bg-rose-500',
}

function siteWidth(site: SiteLoadProgress): string {
  if (site.stage === 'ready')
    return '100%'
  if (site.filesTotal === 0)
    // No file count yet (wasm / manifest phase) — show a fractional sliver so
    // the segment is visible but clearly not done.
    return site.stage === 'wasm' ? '10%' : '25%'
  return `${Math.max(5, Math.round((site.filesAttached / site.filesTotal) * 100))}%`
}

function truncate(id: string, max = 28): string {
  if (id.length <= max)
    return id
  return `${id.slice(0, max - 1)}…`
}
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-200"
    enter-from-class="opacity-0 translate-y-[-4px]"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition-all duration-300"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="!allReady && sites.length > 0"
      class="analytics-boot-progress"
    >
      <button
        type="button"
        class="headline"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span class="dot" :class="stageColor[earliestStage]" />
        <span class="label">{{ stageLabel[earliestStage] }}</span>
        <span class="counter">
          <template v-if="aggregate.total > 0">
            {{ aggregate.attached }} / {{ aggregate.total }}
          </template>
          <template v-else>
            {{ sites.length }} site{{ sites.length === 1 ? '' : 's' }}
          </template>
        </span>
        <span class="caret" :class="{ open: expanded }">⌄</span>
      </button>

      <div class="bar">
        <div
          v-for="site in sites"
          :key="site.siteId"
          class="seg"
          :class="[stageColor[site.stage], { shimmer: anyActive && site.stage !== 'ready' && site.stage !== 'error' }]"
          :style="{ width: siteWidth(site) }"
          :title="`${site.siteId}: ${stageLabel[site.stage]}`"
        />
      </div>

      <Transition
        enter-active-class="transition-all duration-200"
        enter-from-class="opacity-0 max-h-0"
        enter-to-class="opacity-100 max-h-[400px]"
        leave-active-class="transition-all duration-150"
        leave-from-class="opacity-100 max-h-[400px]"
        leave-to-class="opacity-0 max-h-0"
      >
        <ul v-if="expanded" class="rows">
          <li v-for="site in sites" :key="site.siteId" class="row">
            <span class="row-dot" :class="stageColor[site.stage]" />
            <span class="row-id">{{ truncate(site.siteId) }}</span>
            <span class="row-stage">{{ stageLabel[site.stage] }}</span>
            <span class="row-count">
              <template v-if="site.filesTotal > 0">
                {{ site.filesAttached }}/{{ site.filesTotal }}
              </template>
              <template v-else-if="site.stage === 'ready' && site.endedAt">
                {{ Math.round(site.endedAt - site.startedAt) }}ms
              </template>
              <template v-else-if="site.stage === 'error'">
                <span class="err">{{ truncate(site.error ?? 'error', 40) }}</span>
              </template>
              <template v-else>
                —
              </template>
            </span>
          </li>
        </ul>
      </Transition>
    </div>
  </Transition>
</template>

<style scoped>
.analytics-boot-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.headline {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 0;
  padding: 0;
  color: inherit;
  cursor: pointer;
  text-align: left;
  width: 100%;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}
.label {
  color: rgba(255, 255, 255, 0.82);
  font-weight: 500;
}
.counter {
  color: rgba(255, 255, 255, 0.55);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.caret {
  display: inline-block;
  color: rgba(255, 255, 255, 0.4);
  transition: transform 180ms ease;
  width: 10px;
  text-align: center;
}
.caret.open {
  transform: rotate(180deg);
}
.bar {
  display: flex;
  gap: 2px;
  height: 3px;
  width: 100%;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.04);
}
.seg {
  height: 100%;
  border-radius: 2px;
  transition: width 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
  min-width: 4px;
  position: relative;
}
.seg.shimmer::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.28) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  animation: boot-shimmer 1.4s linear infinite;
}
@keyframes boot-shimmer {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}
.rows {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  overflow: hidden;
}
.row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
  color: rgba(255, 255, 255, 0.72);
}
.row + .row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.row-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  margin-left: 2px;
}
.row-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.88);
}
.row-stage {
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
}
.row-count {
  color: rgba(255, 255, 255, 0.7);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  min-width: 60px;
  text-align: right;
}
.row-count .err {
  color: #fb7185;
}
</style>
