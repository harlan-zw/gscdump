<script setup lang="ts">
// Site-scoped page header. Auto-prefixes the `[Overview, hostname-link]`
// crumb trail every `/sites/[id]/*` page repeats, on top of the layer's
// `GscPageHeader`. Hosts pass `:tail` for the remaining crumbs and use
// `<GscPageHeader>` directly for pages that don't fit the standard shape
// (e.g. the site index, where the title IS the hostname).

interface Crumb { label: string, to?: string }

const { tail = [], title, icon, description } = defineProps<{
  tail?: Crumb[]
  title: string
  icon?: string
  description?: string
}>()

const { siteId, site } = useGscCurrentSite()

const crumbs = computed<Crumb[]>(() => [
  { label: 'Overview', to: '/' },
  { label: site.value?.hostname ?? siteId.value, to: `/sites/${encodeURIComponent(siteId.value)}` },
  ...tail,
])
</script>

<template>
  <GscPageHeader
    :crumbs="crumbs"
    :title="title"
    :icon="icon"
    :description="description"
  >
    <template v-if="$slots.icon" #icon>
      <slot name="icon" />
    </template>
    <template #actions>
      <slot name="actions" />
    </template>
  </GscPageHeader>
</template>
