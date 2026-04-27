<script setup lang="ts">
const {
  status,
  error,
  empty,
  skeletonLines = 5,
  skeletonType = 'text',
  emptyIcon = 'i-lucide-inbox',
  emptyTitle = 'No data',
  emptyMessage = 'There is no data to display',
} = defineProps<{
  status: 'idle' | 'pending' | 'success' | 'error'
  error?: Error | null
  empty?: boolean
  skeletonLines?: number
  skeletonType?: 'text' | 'bar' | 'circle'
  emptyIcon?: string
  emptyTitle?: string
  emptyMessage?: string
}>()

const emit = defineEmits<{
  retry: []
}>()

// Suppress loading skeletons until after hydration so server and client
// render the same branch. Lazy fetches transfer data via the SSR payload,
// making status jump from pending→success between render and hydrate.
const hydrated = ref(false)
onMounted(() => {
  hydrated.value = true
})
const isLoading = computed(() => hydrated.value && (status === 'pending' || status === 'idle'))
const isError = computed(() => status === 'error' && !!error)
const isEmpty = computed(() => status === 'success' && empty)
</script>

<template>
  <div data-ui="UiWidgetState" :aria-busy="isLoading">
    <!-- Loading -->
    <slot v-if="isLoading" name="loading">
      <UiSkeleton v-if="skeletonType === 'text'" :lines="skeletonLines" />
      <div v-else-if="skeletonType === 'bar'" class="flex items-end gap-1 h-40">
        <UiSkeleton v-for="i in skeletonLines" :key="i" type="bar" :index="i" />
      </div>
      <UiSkeleton v-else type="circle" :base="skeletonLines" />
    </slot>

    <!-- Error -->
    <slot v-else-if="isError" name="error" :error="error" :retry="() => emit('retry')">
      <div class="flex flex-col items-center justify-center py-8 px-4 text-center">
        <div class="size-10 rounded-xl bg-error/10 flex items-center justify-center mb-3">
          <UIcon name="i-lucide-alert-circle" class="size-5 text-error" />
        </div>
        <p class="text-sm font-medium text-default mb-1">
          Something went wrong
        </p>
        <p v-if="error?.message" class="text-xs text-muted mb-3">
          {{ error.message }}
        </p>
        <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" @click="emit('retry')">
          Retry
        </UButton>
      </div>
    </slot>

    <!-- Empty -->
    <slot v-else-if="isEmpty" name="empty">
      <UiNoData :icon="emptyIcon" :title="emptyTitle" :message="emptyMessage" />
    </slot>

    <!-- Active -->
    <slot v-else />
  </div>
</template>
