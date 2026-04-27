<script setup lang="ts">
// Shared tab bar across /sites/[id]/* routes. Plain anchor-driven — the tab
// routes own their own rendering (NuxtLink). Tabs without a built target
// show as disabled + "soon" until Phase B/C lands.

const { siteId } = defineProps<{ siteId: string }>()

const route = useRoute()
const encoded = computed(() => encodeURIComponent(siteId))
const base = computed(() => `/sites/${encoded.value}`)
const { info } = useGscAnalyticsSourceInfo(() => siteId)
// Lock the Indexing tab when the source is row-only (free tier). The data
// behind it comes from the entity store which only exists on SQL-capable
// deployments — free-tier users can still click through to see the ghost UI.
const locked = computed(() => info.value ? info.value.kind !== 'sql' : false)

interface Tab {
  id: string
  label: string
  to?: string
  soon?: boolean
  lockedWhenRow?: boolean
}

const tabs = computed<Tab[]>(() => [
  { id: 'overview', label: 'Overview', to: base.value },
  { id: 'queries', label: 'Queries', to: `${base.value}/queries` },
  { id: 'pages', label: 'Pages', to: `${base.value}/pages` },
  { id: 'countries', label: 'Countries', to: `${base.value}/countries` },
  { id: 'search-appearance', label: 'Search appearance', to: `${base.value}/search-appearance` },
  { id: 'indexing', label: 'Indexing', to: `${base.value}/indexing`, lockedWhenRow: true },
  { id: 'sitemaps', label: 'Sitemaps', to: `${base.value}/sitemaps` },
  { id: 'insights', label: 'Insights', to: `${base.value}/insights` },
  { id: 'analyze', label: 'Analyze', to: `${base.value}/analyze`, lockedWhenRow: true },
])

function isActive(tab: Tab): boolean {
  if (!tab.to)
    return false
  if (tab.id === 'overview')
    return route.path === tab.to || route.path === `${tab.to}/`
  return route.path.startsWith(tab.to)
}
</script>

<template>
  <nav class="flex items-center gap-0.5 border-b border-default -mb-px overflow-x-auto">
    <template v-for="tab in tabs" :key="tab.id">
      <NuxtLink
        v-if="tab.to"
        :to="tab.to"
        class="px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors cursor-pointer inline-flex items-center gap-1.5"
        :class="isActive(tab)
          ? 'border-primary text-default font-medium'
          : 'border-transparent text-muted hover:text-default'"
      >
        {{ tab.label }}
        <UIcon v-if="tab.lockedWhenRow && locked" name="i-lucide-lock" class="size-3 text-dimmed" />
      </NuxtLink>
      <span
        v-else
        class="px-3 py-2 text-sm whitespace-nowrap border-b-2 border-transparent text-dimmed cursor-not-allowed inline-flex items-center gap-1.5"
        :title="tab.soon ? 'Coming soon' : undefined"
      >
        {{ tab.label }}
        <span v-if="tab.soon" class="text-[10px] uppercase tracking-widest font-semibold text-dimmed/80">soon</span>
      </span>
    </template>
  </nav>
</template>
