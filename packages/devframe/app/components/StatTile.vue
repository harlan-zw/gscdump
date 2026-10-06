<script setup lang="ts">
import type { MetricTotals } from '../../src/shared/protocol'
import type { Metric } from '../format'
import { computed } from 'vue'
import { formatMetric, metricDelta } from '../format'

const { metric, label, totals, previousTotals, previousLabel, selected } = defineProps<{
  metric: Metric
  label: string
  totals: MetricTotals
  previousTotals: MetricTotals | null
  previousLabel: string
  selected: boolean
}>()

const emit = defineEmits<{ select: [metric: Metric] }>()

const delta = computed(() => metricDelta(metric, totals, previousTotals))
const arrow = computed(() => {
  const value = delta.value
  if (value._tag === 'None' || value.direction === 'flat')
    return ''
  return value.direction === 'up' ? '▲' : '▼'
})
const tone = computed(() => {
  const value = delta.value
  if (value._tag === 'None' || value.good == null)
    return 'flat'
  return value.good ? 'good' : 'bad'
})
</script>

<template>
  <button
    type="button"
    class="tile"
    :class="{ selected }"
    :aria-pressed="selected"
    :style="{ '--series': `var(--metric-${metric})` }"
    @click="emit('select', metric)"
  >
    <span class="label">
      <span class="key" aria-hidden="true" />
      {{ label }}
    </span>
    <span class="value">{{ formatMetric(totals[metric], metric, 'compact') }}</span>
    <span v-if="delta._tag === 'Change'" class="delta tabular" :class="tone" :title="`Change against the ${previousLabel}`">
      <span aria-hidden="true">{{ arrow }}</span>
      {{ delta.text }}
      <span class="sr-only">against the {{ previousLabel }}</span>
    </span>
    <span v-else class="delta flat">No comparison</span>
  </button>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
}

.tile:hover {
  border-color: var(--dimmed);
}

.tile.selected {
  border-color: var(--series);
  box-shadow: inset 0 -2px 0 var(--series);
}

.label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}

.key {
  width: 10px;
  height: 2px;
  border-radius: 1px;
  background: var(--series);
}

.value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
}

.delta {
  font-size: 12px;
  color: var(--muted);
}

.delta.good {
  color: var(--good);
}

.delta.bad {
  color: var(--bad);
}
</style>
