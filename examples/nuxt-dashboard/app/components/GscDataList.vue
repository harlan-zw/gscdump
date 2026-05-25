<script setup lang="ts">
interface DataListRow {
  label: string
  metric: number
  secondary?: string
}

defineProps<{
  title: string
  description?: string
  rows: DataListRow[]
  empty?: string | null
}>()
</script>

<template>
  <section class="rounded-lg border border-default bg-default overflow-hidden">
    <div class="px-4 py-3 border-b border-default">
      <h2 class="text-sm font-semibold text-default">
        {{ title }}
      </h2>
      <p v-if="description" class="text-[11px] text-dimmed">
        {{ description }}
      </p>
    </div>

    <div v-if="empty" class="p-6 text-sm text-muted text-center">
      {{ empty }}
    </div>
    <ul v-else class="divide-y divide-default">
      <li
        v-for="(row, i) in rows"
        :key="`${row.label}:${i}`"
        class="px-4 py-2.5 flex items-center gap-3"
      >
        <span class="text-[11px] tabular-nums text-dimmed w-6 text-right shrink-0">
          {{ i + 1 }}
        </span>
        <span class="min-w-0 flex-1 truncate text-sm text-default" :title="row.label">
          {{ row.label }}
        </span>
        <span v-if="row.secondary" class="text-xs text-dimmed tabular-nums whitespace-nowrap">
          {{ row.secondary }}
        </span>
        <span class="text-sm font-medium text-default tabular-nums whitespace-nowrap">
          {{ row.metric.toLocaleString() }}
        </span>
      </li>
      <li v-if="rows.length === 0" class="p-6 text-sm text-muted text-center">
        No rows.
      </li>
    </ul>
  </section>
</template>
