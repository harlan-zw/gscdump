<script setup lang="ts">
const props = defineProps<{
  data?: {
    status: string
    rowsFetched: number
    rowsInserted: number
    error: string | null
  }
}>()

const statusColor = computed(() => {
  if (!props.data)
    return 'text-muted'
  switch (props.data.status) {
    case 'completed': return 'text-success'
    case 'processing': return 'text-info'
    case 'queued': return 'text-muted'
    case 'failed': return 'text-error'
    default: return 'text-muted'
  }
})

const statusIcon = computed(() => {
  if (!props.data)
    return '-'
  switch (props.data.status) {
    case 'completed': return '✓'
    case 'processing': return '⟳'
    case 'queued': return '○'
    case 'failed': return '✗'
    default: return '?'
  }
})
</script>

<template>
  <span v-if="!data" class="text-muted">-</span>
  <UTooltip v-else>
    <span :class="statusColor" class="font-mono">
      {{ statusIcon }}
      <span v-if="data.status === 'completed'" class="text-muted ml-1">{{ data.rowsFetched }}</span>
    </span>
    <template #content>
      <div class="text-xs space-y-1">
        <div>Status: {{ data.status }}</div>
        <div>Fetched: {{ data.rowsFetched?.toLocaleString() || 0 }}</div>
        <div>Inserted: {{ data.rowsInserted?.toLocaleString() || 0 }}</div>
        <div v-if="data.error" class="text-error">
          Error: {{ data.error }}
        </div>
      </div>
    </template>
  </UTooltip>
</template>
