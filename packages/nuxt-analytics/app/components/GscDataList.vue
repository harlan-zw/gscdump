<script setup lang="ts">
// Title + bar-value rows. Core mover-list pattern used across every ranking
// widget (top queries, top pages, biggest gainers, biggest losers).
//
// Rows come in pre-computed — the component doesn't know about analyzers or
// rollups, it just renders. `metric` is the primary number (clicks, delta, …)
// drawn as a horizontal bar relative to the row with the max value. `secondary`
// renders as a small right-aligned note under the bar.

interface DataListRow {
  label: string
  metric: number
  /** Shown as a secondary muted line under the metric. Optional. */
  secondary?: string
  /** Optional deep-link target for the label. */
  href?: string
}

const {
  title,
  description,
  rows,
  formatMetric,
  empty = 'No data yet.',
  showBars = true,
} = defineProps<{
  title?: string
  description?: string
  rows: DataListRow[]
  formatMetric?: (n: number) => string
  empty?: string
  showBars?: boolean
}>()

const maxMetric = computed(() => {
  let max = 0
  for (const r of rows) {
    const v = Math.abs(r.metric)
    if (v > max)
      max = v
  }
  return max || 1
})

const fmtFallback = new Intl.NumberFormat()
function fmt(n: number): string {
  return formatMetric ? formatMetric(n) : fmtFallback.format(Math.round(n))
}
</script>

<template>
  <div class="rounded-lg border border-default bg-default overflow-hidden">
    <div v-if="title || description" class="px-4 py-3 border-b border-default">
      <h3 v-if="title" class="text-sm font-semibold tracking-tight text-default">
        {{ title }}
      </h3>
      <p v-if="description" class="text-[11px] text-muted mt-0.5">
        {{ description }}
      </p>
    </div>
    <div v-if="!rows.length" class="px-4 py-8 text-center text-sm text-muted">
      {{ empty }}
    </div>
    <ol v-else class="divide-y divide-default">
      <li
        v-for="(row, i) in rows"
        :key="`${row.label}-${i}`"
        class="px-4 py-2 flex items-center gap-3 text-sm"
      >
        <span class="text-[11px] tabular-nums text-dimmed w-5 shrink-0 text-right">
          {{ i + 1 }}
        </span>
        <div class="min-w-0 flex-1">
          <component
            :is="row.href ? 'NuxtLink' : 'span'"
            :to="row.href"
            :title="row.label"
            class="truncate block"
            :class="row.href ? 'text-default hover:text-primary hover:underline' : 'text-default'"
          >
            {{ row.label }}
          </component>
          <div
            v-if="showBars"
            class="mt-1 h-1 rounded-full bg-elevated overflow-hidden"
          >
            <div
              class="h-full bg-primary/70 rounded-full"
              :style="{ width: `${Math.min(100, (Math.abs(row.metric) / maxMetric) * 100)}%` }"
            />
          </div>
        </div>
        <div class="shrink-0 text-right">
          <div class="tabular-nums text-default text-[13px] font-medium">
            {{ fmt(row.metric) }}
          </div>
          <div v-if="row.secondary" class="text-[11px] text-dimmed tabular-nums">
            {{ row.secondary }}
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>
