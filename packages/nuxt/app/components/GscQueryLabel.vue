<script setup lang="ts">
// Keyword cell: keyword text + optional best-position chip + optional variant
// badge. Deliberately small — callers lay it out inside their own row/table.

const { keyword, position, variantCount = 0, href } = defineProps<{
  keyword: string
  position?: number
  /** Number of GSC query-variants folded into this canonical keyword. */
  variantCount?: number
  href?: string
}>()

const positionLabel = computed(() => {
  if (position == null || !Number.isFinite(position) || position <= 0)
    return null
  return position.toFixed(1)
})

const positionColor = computed<'success' | 'warning' | 'neutral' | 'error'>(() => {
  if (position == null)
    return 'neutral'
  if (position <= 3)
    return 'success'
  if (position <= 10)
    return 'warning'
  if (position <= 20)
    return 'neutral'
  return 'error'
})
</script>

<template>
  <div class="flex items-center gap-2 min-w-0">
    <component
      :is="href ? 'NuxtLink' : 'span'"
      :to="href"
      class="truncate text-default"
      :class="href ? 'hover:text-primary hover:underline' : ''"
      :title="keyword"
    >
      {{ keyword }}
    </component>
    <UBadge
      v-if="positionLabel"
      :color="positionColor"
      variant="soft"
      size="xs"
      class="tabular-nums shrink-0"
    >
      #{{ positionLabel }}
    </UBadge>
    <UBadge
      v-if="variantCount > 1"
      color="neutral"
      variant="soft"
      size="xs"
      class="tabular-nums shrink-0"
      :title="`${variantCount} GSC query variants folded into this keyword`"
    >
      +{{ variantCount - 1 }}
    </UBadge>
  </div>
</template>
