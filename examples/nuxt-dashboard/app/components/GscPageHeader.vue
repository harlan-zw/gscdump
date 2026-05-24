<script setup lang="ts">
interface Crumb {
  label: string
  to?: string
}

defineProps<{
  crumbs?: Crumb[]
  title: string
  icon?: string
  description?: string
}>()
</script>

<template>
  <PageHeader
    :crumbs="crumbs"
    :title="title"
    :icon="icon"
    :description="description"
  >
    <template v-if="$slots.icon" #icon>
      <slot name="icon" />
    </template>
    <template v-if="$slots.actions" #actions>
      <slot name="actions" />
    </template>
  </PageHeader>
</template>
