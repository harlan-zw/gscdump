<script setup lang="ts">
// Server-rendered action-priority preview. Fetches /api/report which runs
// the same five analyzers the Actions tab runs, but on the server's Node
// DuckDB engine. This is what a scheduled report would emit.

import type { ActionPrioritySourceState, PriorityAction } from '@gscdump/analysis'

interface ReportPayload {
  actions: PriorityAction[]
  totalSignals: number
  sources: ActionPrioritySourceState[]
  generatedAt: string
  timings: { setupMs: number, analyzeMs: number, totalMs: number }
}

const data = ref<ReportPayload | null>(null)
const error = ref<Error | null>(null)
const loading = ref(false)
const limit = ref(40)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    data.value = await $fetch<ReportPayload>('/api/report', { query: { limit: limit.value } })
  }
  catch (err) {
    error.value = err instanceof Error ? err : new Error(String(err))
  }
  finally {
    loading.value = false
  }
}

onMounted(load)

const sourceColor: Record<string, string> = {
  done: '#2d9a6a',
  running: '#7a6cd0',
  pending: '#888',
  skipped: '#b25900',
  error: '#c52d45',
}
</script>

<template>
  <div class="shell">
    <header>
      <h1>Scheduled report preview</h1>
      <p>Server-side digest. Same engine + analyzers as the dashboard, no browser DuckDB.</p>
    </header>

    <div class="bar">
      <button :disabled="loading" @click="load">
        {{ loading ? 'Running…' : data ? 'Re-run' : 'Generate' }}
      </button>
      <label class="limit">
        top
        <select v-model.number="limit" :disabled="loading">
          <option :value="20">20</option>
          <option :value="40">40</option>
          <option :value="80">80</option>
        </select>
        actions
      </label>
      <span v-if="data" class="dim">
        generated {{ new Date(data.generatedAt).toLocaleString() }}
        · setup {{ Math.round(data.timings.setupMs) }} ms
        · analyze {{ Math.round(data.timings.analyzeMs) }} ms
        · total {{ Math.round(data.timings.totalMs) }} ms
      </span>
    </div>

    <div v-if="data" class="sources">
      <div v-for="s in data.sources" :key="s.source" class="src">
        <span class="dot" :style="{ background: sourceColor[s.status] ?? '#888' }" />
        <code>{{ s.source }}</code>
        <span class="src-status">{{ s.status }}</span>
        <span v-if="s.count" class="src-count">{{ s.count }} signals</span>
        <span v-if="s.error" class="src-err">{{ s.error }}</span>
      </div>
    </div>

    <div v-if="error" class="err-box">
      {{ error.message }}
    </div>
    <div v-else-if="loading && !data" class="loading">
      Booting server engine, running 5 analyzers in parallel…
    </div>
    <div v-else-if="data && data.actions.length === 0" class="empty">
      No actions surfaced. {{ data.totalSignals }} raw signals collected.
    </div>
    <ActionPriorityPanel v-else-if="data" :actions="data.actions" />

    <p v-if="data" class="caption">
      {{ data.actions.length }} actions ranked from {{ data.totalSignals }} signals.
      In production, swap the page for a cron-fired job that POSTs this payload
      to email / Slack / a storage bucket.
    </p>
  </div>
</template>

<style scoped>
.shell { max-width: 1040px; margin: 0 auto; padding: 2rem 1.5rem 3rem; font-family: system-ui, -apple-system, sans-serif; color: #1d1d1f; }
header h1 { margin: 0; font-size: 1.6rem; }
header p { margin: 0.25rem 0 0; color: #666; font-size: 0.9rem; }

.bar { display: flex; gap: 1rem; align-items: center; margin: 1rem 0 0.85rem; flex-wrap: wrap; }
.bar button { padding: 0.55rem 1.1rem; border: 0; border-radius: 4px; background: #4c3ca0; color: #fff; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
.bar button:disabled { opacity: 0.5; cursor: not-allowed; }
.bar .limit { font-size: 0.82rem; color: #555; display: inline-flex; align-items: center; gap: 0.4rem; }
.bar select { padding: 0.25rem 0.4rem; border: 1px solid #e2e2e5; border-radius: 4px; font: inherit; background: #fff; }
.bar .dim { font-family: ui-monospace, monospace; font-size: 0.74rem; color: #888; margin-left: auto; }

.sources { display: flex; gap: 1.25rem; flex-wrap: wrap; padding: 0.6rem 0.9rem; background: #fafafb; border: 1px solid #ececef; border-radius: 6px; margin-bottom: 0.85rem; font-size: 0.78rem; color: #444; }
.src { display: inline-flex; align-items: center; gap: 0.4rem; }
.dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; display: inline-block; }
.src code { font-size: 0.75rem; color: #1d1d1f; }
.src-status { color: #666; font-variant-numeric: tabular-nums; }
.src-count { color: #888; font-variant-numeric: tabular-nums; }
.src-err { color: #c52d45; font-family: ui-monospace, monospace; font-size: 0.72rem; }

.err-box { padding: 1rem 1.25rem; color: #c00; background: #fff5f5; font-family: ui-monospace, monospace; font-size: 0.82rem; white-space: pre-wrap; border: 1px solid #f4d4d4; border-radius: 6px; }
.loading, .empty { padding: 2.5rem; text-align: center; color: #888; font-size: 0.9rem; background: #fff; border: 1px solid #ececef; border-radius: 6px; }
.caption { margin: 0.85rem 0 0; font-size: 0.78rem; color: #666; font-style: italic; text-align: center; }
</style>
