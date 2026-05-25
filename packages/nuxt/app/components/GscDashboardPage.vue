<script setup lang="ts">
// Thin page container: sets the `flex flex-col min-h-screen` chrome every
// site-scoped page has been repeating and provides a main-region slot with
// the shared max-width + padding. Use together with PageHeader.

const { gap = 'md' } = defineProps<{
  /** Spacing between direct children of the main region. Maps to tailwind gap-3/4/5. */
  gap?: 'sm' | 'md' | 'lg'
}>()

const gapClass = computed(() => (
  gap === 'sm' ? 'gap-3' : gap === 'lg' ? 'gap-5' : 'gap-4'
))
</script>

<template>
  <div class="flex flex-col min-h-screen overflow-x-clip">
    <slot name="header" />
    <div
      class="max-w-[1128px] min-w-0 px-4 sm:px-6 lg:px-9 pt-4 pb-10 flex flex-col flex-1 w-full"
      :class="gapClass"
    >
      <slot />
    </div>
  </div>
</template>
