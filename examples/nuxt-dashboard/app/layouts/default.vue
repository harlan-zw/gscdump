<script setup lang="ts">
const route = useRoute()
// Analytics context is provided by the layer's `plugins/analytics.ts` at
// app root, exposed via `useNuxtApp().$gscAnalytics`. Per-page overrides
// can re-provide `$gscAnalytics` from a page-local plugin.
const { sites, loading: sitesLoading } = useGscSites()

// `mode` is host-specific (example dashboard's local|origin|consumer switch),
// so we cast inline; layer-known keys go through useGscAnalyticsConfig().
const analyticsCfg = useRuntimeConfig().public.analytics as unknown as { mode?: string }
const mode = analyticsCfg?.mode ?? 'local'
const siteId = computed(() => route.path.startsWith('/sites/') ? String(route.params.id ?? '') : '')
provideGscCurrentSite(siteId)
const activeSite = computed(() => sites.value?.find(site => site.id === siteId.value) ?? null)
const inSite = computed(() => Boolean(siteId.value))
const siteListTitle = computed(() => inSite.value ? 'Switch site' : 'Sites')

function isSiteActive(id: string) {
  return route.path === `/sites/${id}` || route.path.startsWith(`/sites/${id}/`)
}
</script>

<template>
  <div class="flex min-h-screen bg-default">
    <aside class="hidden lg:flex flex-col shrink-0 fixed top-0 bottom-0 left-0 w-64 border-r border-default bg-default">
      <div class="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        <NuxtLink to="/" class="flex flex-col gap-0.5 px-2">
          <span class="font-bold text-base text-highlighted tracking-tight">gscdump</span>
          <span class="text-[11px] text-dimmed font-mono">DuckDB · parquet · R2</span>
        </NuxtLink>

        <nav class="space-y-0.5">
          <NuxtLink
            to="/"
            class="flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors"
            :class="route.path === '/' ? 'bg-elevated text-highlighted font-medium' : 'text-muted hover:text-default hover:bg-elevated/50'"
          >
            <UIcon name="i-lucide-layout-dashboard" class="size-4 shrink-0" />
            Overview
          </NuxtLink>
          <NuxtLink
            to="/partner"
            class="flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors"
            :class="route.path === '/partner' ? 'bg-elevated text-highlighted font-medium' : 'text-muted hover:text-default hover:bg-elevated/50'"
          >
            <UIcon name="i-lucide-plug" class="size-4 shrink-0" />
            Partner API
          </NuxtLink>
        </nav>

        <div v-if="inSite" class="space-y-3">
          <div class="px-2">
            <NuxtLink
              :to="`/sites/${encodeURIComponent(siteId)}`"
              class="flex items-center gap-2 rounded px-0 py-1 text-sm text-highlighted hover:text-default"
            >
              <GscFavicon
                v-if="activeSite?.hostname"
                :domain="activeSite.hostname"
                :size="18"
                :alt="activeSite.hostname"
              />
              <UIcon v-else name="i-lucide-globe" class="size-4 text-dimmed shrink-0" />
              <span class="min-w-0">
                <span class="block truncate font-medium">{{ activeSite?.hostname ?? siteId }}</span>
                <span class="block truncate text-[11px] text-dimmed">{{ activeSite?.propertyType ?? 'site' }}</span>
              </span>
            </NuxtLink>
          </div>

          <SiteSidebarNav :site-id="siteId" />
        </div>

        <div>
          <div class="text-[11px] font-semibold text-dimmed uppercase tracking-widest px-2 mb-2">
            {{ siteListTitle }}
          </div>
          <nav class="space-y-0.5">
            <div v-if="sitesLoading" class="px-2 py-1 text-xs text-dimmed">
              loading…
            </div>
            <template v-else>
              <NuxtLink
                v-for="site in sites"
                :key="site.id"
                :to="`/sites/${encodeURIComponent(site.id)}`"
                class="flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors"
                :class="isSiteActive(site.id) ? 'bg-elevated text-highlighted font-medium' : 'text-muted hover:text-default hover:bg-elevated/50'"
                :title="site.label"
              >
                <GscFavicon :domain="site.hostname" :size="14" :alt="site.hostname" />
                <span class="truncate text-[13px]">{{ site.hostname }}</span>
              </NuxtLink>
              <div v-if="!sites?.length" class="px-2 py-1 text-xs text-dimmed">
                no sites
              </div>
            </template>
          </nav>
        </div>
      </div>

      <div class="shrink-0 border-t border-default px-3 py-3 text-[11px] text-dimmed flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2" data-testid="analytics-mode">
          <span class="text-dimmed">Layer mode</span>
          <span class="font-mono text-[10px] text-default uppercase tracking-wider" :data-mode="mode">{{ mode }}</span>
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-dimmed">Demo tier</span>
          <TierSwitcher />
        </div>
        <a href="https://github.com/harlan-zw/gscdump" class="hover:text-muted inline-flex items-center gap-1.5" target="_blank">
          <UIcon name="i-simple-icons-github" class="size-3" /> github.com/harlan-zw/gscdump
        </a>
      </div>
    </aside>

    <div class="flex-1 min-w-0 lg:ml-64">
      <div class="lg:hidden px-4 pt-4">
        <UButton variant="ghost" icon="i-lucide-menu" size="sm">
          Menu
        </UButton>
      </div>
      <slot />
    </div>

    <GscCommandPalette />
    <GscSourceDebugPanel />
  </div>
</template>
