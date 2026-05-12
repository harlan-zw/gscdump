<script setup lang="ts">
// Unified shell for `/analyze` analyzer tabs. Drives the chrome that 11
// per-analyzer sections used to repeat: stat tiles, body, caption. The body
// component + tile projection + caption come from `def.capabilities.panel`;
// the shell owns the loading/error/empty gating unless `panel.ownsLifecycle`
// is set (pipeline panels manage their own phase state internally).

import type {
  GscAnalyzerDefinition,
  GscAnalyzerPanelResult,
} from '../composables/useGscAnalyzerDefs'

interface Props {
  def: GscAnalyzerDefinition
  rows: unknown[]
  meta: Record<string, unknown> | null
  queryMs?: number | null
  loading?: boolean
  error?: string | null
  /** Forwarded to the body component as `range`. Optional. */
  range?: { start: string, end: string } | null
}

const props = defineProps<Props>()

const panel = computed(() => props.def.capabilities?.panel)

const tiles = computed(() => {
  const p = panel.value
  if (!p?.summarize)
    return []
  const result: GscAnalyzerPanelResult = {
    results: props.rows,
    meta: props.meta ?? {},
    queryMs: props.queryMs ?? null,
  }
  return p.summarize(result)
})

const showBody = computed(() => {
  if (!panel.value)
    return false
  if (panel.value.ownsLifecycle)
    return true
  return !props.loading && !props.error && props.rows.length > 0
})

const bodyProps = computed(() => ({
  rows: props.rows,
  meta: props.meta ?? {},
  range: props.range ?? null,
}))
</script>

<template>
  <section v-if="panel" class="gsc-analyzer-panel">
    <div v-if="tiles.length > 0" class="gsc-analyzer-panel__tiles">
      <div v-for="(t, i) in tiles" :key="`${t.label}-${i}`" class="gsc-analyzer-panel__tile">
        <span class="gsc-analyzer-panel__tile-label">{{ t.label }}</span>
        <span class="gsc-analyzer-panel__tile-value" :style="t.valueColor ? { color: t.valueColor } : undefined">{{ t.value }}</span>
      </div>
    </div>

    <template v-if="!panel.ownsLifecycle">
      <div v-if="error" class="gsc-analyzer-panel__error">
        {{ error }}
      </div>
      <div v-else-if="loading" class="gsc-analyzer-panel__loading">
        Running analyzer…
      </div>
      <div v-else-if="rows.length === 0" class="gsc-analyzer-panel__empty">
        No rows.
      </div>
    </template>

    <component :is="panel.component" v-if="showBody" v-bind="bodyProps" />

    <p v-if="panel.caption" class="gsc-analyzer-panel__caption">
      <slot name="caption">{{ panel.caption }}</slot>
    </p>
  </section>
</template>

<style scoped>
.gsc-analyzer-panel { background: #fff; border: 1px solid #ececef; border-top: 0; border-radius: 0 0 6px 6px; padding: 1rem 1rem 0.9rem; }
.gsc-analyzer-panel__tiles { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 0.85rem; padding: 0 0.15rem; }
.gsc-analyzer-panel__tile { display: flex; flex-direction: column; gap: 0.1rem; }
.gsc-analyzer-panel__tile-label { font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase; color: #888; }
.gsc-analyzer-panel__tile-value { font-size: 1.3rem; font-weight: 600; color: #1d1d1f; font-variant-numeric: tabular-nums; }
.gsc-analyzer-panel__caption { margin: 0.8rem 0 0; font-size: 0.78rem; color: #666; font-style: italic; text-align: center; }
.gsc-analyzer-panel__caption :deep(code) { background: #f0f0f3; padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.74rem; color: #4c3ca0; }
.gsc-analyzer-panel__error { padding: 1rem 1.25rem; color: #c00; background: #fff5f5; font-family: ui-monospace, monospace; font-size: 0.82rem; white-space: pre-wrap; }
.gsc-analyzer-panel__loading, .gsc-analyzer-panel__empty { padding: 2.5rem; text-align: center; color: var(--ui-text-dimmed); font-size: 0.9rem; }
</style>
