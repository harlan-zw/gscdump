<script setup lang="ts">
const props = defineProps<{
  siteId: string
}>()

const route = useRoute()
const encoded = computed(() => encodeURIComponent(props.siteId))
const base = computed(() => `/sites/${encoded.value}`)
interface Tab {
  id: string
  label: string
  icon: string
  to: string
}

const tabs = computed<Tab[]>(() => [
  { id: 'overview', label: 'Overview', icon: 'i-lucide-layout-dashboard', to: base.value },
  { id: 'queries', label: 'Queries', icon: 'i-lucide-search', to: `${base.value}/queries` },
  { id: 'pages', label: 'Pages', icon: 'i-lucide-file-text', to: `${base.value}/pages` },
  { id: 'countries', label: 'Countries', icon: 'i-lucide-globe-2', to: `${base.value}/countries` },
  { id: 'search-appearance', label: 'Search appearance', icon: 'i-lucide-sparkles', to: `${base.value}/search-appearance` },
  { id: 'indexing', label: 'Indexing', icon: 'i-lucide-scan-search', to: `${base.value}/indexing` },
  { id: 'sitemaps', label: 'Sitemaps', icon: 'i-lucide-list-tree', to: `${base.value}/sitemaps` },
  { id: 'insights', label: 'Insights', icon: 'i-lucide-lightbulb', to: `${base.value}/insights` },
  { id: 'analyze', label: 'Analyze', icon: 'i-lucide-flask-conical', to: `${base.value}/analyze` },
])

function isActive(tab: Tab): boolean {
  if (tab.id === 'overview')
    return route.path === tab.to || route.path === `${tab.to}/`
  return route.path.startsWith(tab.to)
}
</script>

<template>
  <nav class="space-y-0.5">
    <NuxtLink
      v-for="tab in tabs"
      :key="tab.id"
      :to="tab.to"
      class="flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors"
      :class="isActive(tab)
        ? 'bg-elevated text-highlighted font-medium'
        : 'text-muted hover:text-default hover:bg-elevated/50'"
    >
      <UIcon :name="tab.icon" class="size-4 shrink-0" />
      <span class="min-w-0 flex-1 truncate">{{ tab.label }}</span>
    </NuxtLink>
  </nav>
</template>
