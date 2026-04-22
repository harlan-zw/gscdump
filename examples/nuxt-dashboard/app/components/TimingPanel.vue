<script setup lang="ts">
interface Timings {
  bootMs?: number
  manifestMs?: number
  attachMs?: number
  queryMs?: number
  rollupMs?: number
  setupMs?: number
  totalMs?: number
}

const { timings, source, rtt } = defineProps<{
  timings: Timings | Record<string, unknown> | null | undefined
  source: 'browser' | 'server' | null
  rtt?: number | null
}>()

function t(key: keyof Timings): number | undefined {
  const v = (timings as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === 'number' ? v : undefined
}

function fmt(n?: number | null): string {
  if (n == null)
    return '—'
  if (n < 1)
    return '<1 ms'
  return `${Math.round(n)} ms`
}
</script>

<template>
  <div class="timing">
    <div class="label">
      <span class="dot" :class="source" />{{ source ?? 'idle' }}
    </div>
    <template v-if="source === 'browser' && timings">
      <span>boot <b>{{ fmt(t('bootMs')) }}</b></span>
      <span>manifest <b>{{ fmt(t('manifestMs')) }}</b></span>
      <span>attach <b>{{ fmt(t('attachMs')) }}</b></span>
      <span>rollup <b>{{ fmt(t('rollupMs')) }}</b></span>
      <span>query <b>{{ fmt(t('queryMs')) }}</b></span>
    </template>
    <template v-else-if="source === 'server' && timings">
      <span>server setup <b>{{ fmt(t('setupMs')) }}</b></span>
      <span>server query <b>{{ fmt(t('queryMs')) }}</b></span>
      <span>round-trip <b>{{ fmt(rtt) }}</b></span>
    </template>
  </div>
</template>

<style scoped>
.timing {
  display: flex; gap: 1.25rem; align-items: center;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.78rem; color: #555;
  padding: 0.5rem 0.75rem; background: #f7f7f8;
  border-radius: 6px;
  flex-wrap: wrap;
}
.timing b { color: #111; font-weight: 600; }
.label { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 600; color: #111; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #c0c0c6; display: inline-block; }
.dot.browser { background: #10b981; }
.dot.server { background: #3b82f6; }
</style>
