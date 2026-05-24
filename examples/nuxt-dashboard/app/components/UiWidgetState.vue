<script setup lang="ts">
withDefaults(defineProps<{
  status?: 'idle' | 'pending' | 'success' | 'error'
  error?: Error | null
  empty?: boolean
  skeletonLines?: number
  emptyIcon?: string
  emptyTitle?: string
  emptyMessage?: string
}>(), {
  status: 'idle',
  error: null,
  empty: false,
  skeletonLines: 3,
  emptyIcon: 'i-lucide-inbox',
  emptyTitle: 'No data',
  emptyMessage: '',
})
</script>

<template>
  <div>
    <div v-if="status === 'pending'" class="rounded-lg border border-default bg-default p-4 space-y-3">
      <div
        v-for="line in skeletonLines"
        :key="line"
        class="h-4 rounded bg-muted/30 animate-pulse"
        :class="line === skeletonLines ? 'w-2/3' : 'w-full'"
      />
    </div>
    <UAlert
      v-else-if="status === 'error'"
      color="error"
      variant="soft"
      icon="i-lucide-alert-triangle"
      title="Could not load data"
      :description="error?.message ?? 'Unknown error'"
    />
    <div
      v-else-if="empty"
      class="rounded-lg border border-default bg-default px-6 py-10 text-center"
    >
      <UIcon :name="emptyIcon" class="mx-auto size-6 text-dimmed" />
      <div class="mt-3 text-sm font-medium text-default">
        {{ emptyTitle }}
      </div>
      <div v-if="emptyMessage" class="mt-1 text-[13px] text-muted">
        {{ emptyMessage }}
      </div>
    </div>
    <slot v-else />
  </div>
</template>
