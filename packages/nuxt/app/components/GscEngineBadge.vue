<script setup lang="ts">
// Small observability pill: shows which backend served the query
// (browser/DuckDB-WASM vs server/D1), how long it took, and the fallback
// reason if the browser path tried and failed. Silent until data settles.

const { engine, elapsedMs = null, fallbackReason = null } = defineProps<{
  engine: 'browser' | 'server' | null
  elapsedMs?: number | null
  fallbackReason?: string | null
}>()
</script>

<template>
  <div v-if="engine" class="flex items-center gap-2 text-[10px] font-mono uppercase text-neutral-500">
    <span
      class="px-1.5 py-0.5 border"
      :class="engine === 'browser'
        ? 'border-cyan-500/40 text-cyan-400 bg-cyan-500/5'
        : 'border-white/15 text-neutral-400 bg-white/5'"
    >
      engine: {{ engine }}
    </span>
    <span v-if="elapsedMs != null">{{ Math.round(elapsedMs) }} ms</span>
    <span v-if="fallbackReason" class="text-amber-500" :title="fallbackReason">
      fallback
    </span>
  </div>
</template>
