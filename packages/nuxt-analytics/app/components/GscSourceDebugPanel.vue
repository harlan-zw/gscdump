<script setup lang="ts">
// Floating debug panel showing which AnalysisQuerySource the server resolved
// for the current site. Reads `/api/__gsc/sites/:siteId/source-info`. Ships in the
// layer so every consumer gets the same shape without reimplementing.
//
// Siting:
//  - `site` prop > `siteId` prop > route param `id` (the canonical path)
//  - Off-site routes (overview, /pricing, etc.) render a "no site context" tile.
//
// Visibility:
//  - Hidden by default; click the floating ⓘ pill to open.
//  - Preference persists in localStorage per origin (key `gsc-debug-panel`).

import { useGscFetch } from '../utils/gsc-fetch'

const props = defineProps<{
  /** Explicit site id. Falls back to route.params.id. */
  site?: string
  /** @deprecated Use `site`. Kept so older callers still type-check. */
  siteId?: string
}>()

const route = useRoute()
const resolvedSite = computed(() => props.site ?? props.siteId ?? (typeof route.params.id === 'string' ? route.params.id : null))

const open = useLocalStorage('gsc-debug-panel', false)

const { info, loading, error } = useGscAnalyticsSourceInfo(() => resolvedSite.value)

// Off-site fallback — `/api/__gsc/whoami` exposes identity.attrs (tier,
// plan, etc.) so the panel can still show viewer context on routes without
// a site (overview, pricing, landing pages). Only fetched when we have no
// site to resolve, so per-site routes pay nothing for this.
interface WhoamiResponse {
  userId: string
  siteIds: string[] | null
  identityAttrs: Record<string, unknown>
  sourceProviderRegistered: boolean
}
const whoami = ref<WhoamiResponse | null>(null)
const whoamiLoading = ref(false)
watchEffect(() => {
  if (!import.meta.client || resolvedSite.value || !open.value || whoami.value || whoamiLoading.value)
    return
  whoamiLoading.value = true
  useGscFetch()<WhoamiResponse>('/api/__gsc/whoami')
    .then((res) => { whoami.value = res })
    .catch(() => { /* surface via empty state, not a toast */ })
    .finally(() => { whoamiLoading.value = false })
})

function fmtKind(kind: 'row' | 'sql'): string {
  return kind === 'sql' ? 'SQL' : 'Rows'
}
</script>

<template>
  <ClientOnly>
    <!-- Toggle affordance: always visible, bottom-right. -->
    <button
      type="button"
      class="fixed z-40 bottom-3 right-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-default bg-default/90 backdrop-blur text-[11px] font-mono text-muted hover:text-default shadow-sm transition-colors"
      :title="open ? 'Hide data-source debug panel' : 'Show data-source debug panel'"
      @click="open = !open"
    >
      <span class="size-1.5 rounded-full" :class="info ? (info.kind === 'sql' ? 'bg-primary' : 'bg-amber-500') : 'bg-dimmed'" />
      src: {{ info?.name ?? (loading ? '…' : resolvedSite ? '—' : 'no site') }}
      <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" class="size-3" />
    </button>

    <!-- Panel body -->
    <div
      v-if="open"
      class="fixed z-40 bottom-12 right-3 w-[320px] rounded-lg border border-default bg-default/95 backdrop-blur shadow-lg text-[12px] font-mono"
    >
      <header class="flex items-center justify-between px-3 py-2 border-b border-default">
        <span class="font-semibold text-default">Analytics source</span>
        <button type="button" class="text-dimmed hover:text-default" @click="open = false">
          <UIcon name="i-lucide-x" class="size-3.5" />
        </button>
      </header>

      <div v-if="!resolvedSite" class="flex flex-col divide-y divide-default">
        <div class="px-3 py-2.5 text-dimmed text-[11px] leading-snug">
          No site context on this route. Showing identity only.
        </div>
        <div v-if="whoamiLoading && !whoami" class="p-3 text-dimmed">
          Resolving…
        </div>
        <div v-else-if="whoami" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2.5">
          <span class="text-dimmed">userId</span>
          <span class="text-default truncate" :title="whoami.userId">{{ whoami.userId }}</span>

          <span class="text-dimmed">sites</span>
          <span class="text-default">
            {{ whoami.siteIds == null ? 'all' : `${whoami.siteIds.length} scoped` }}
          </span>

          <span class="text-dimmed">source</span>
          <span :class="whoami.sourceProviderRegistered ? 'text-success' : 'text-error'">
            {{ whoami.sourceProviderRegistered ? 'registered' : 'not registered' }}
          </span>

          <template v-for="(value, key) in whoami.identityAttrs" :key="key">
            <span class="text-dimmed">{{ key }}</span>
            <span class="text-default truncate" :title="String(value)">{{ String(value) }}</span>
          </template>
        </div>
      </div>
      <div v-else-if="loading && !info" class="p-3 text-dimmed">
        Resolving…
      </div>
      <div v-else-if="error" class="p-3 text-error">
        <div class="font-semibold mb-1">
          Failed to resolve source
        </div>
        <div class="text-[11px] leading-snug">
          {{ error.message }}
        </div>
      </div>
      <div v-else-if="info" class="flex flex-col divide-y divide-default">
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2.5">
          <span class="text-dimmed">site</span>
          <span class="truncate text-default" :title="resolvedSite">{{ resolvedSite }}</span>

          <span class="text-dimmed">name</span>
          <span class="text-default">{{ info.name }}</span>

          <span class="text-dimmed">kind</span>
          <span>
            <span
              class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold"
              :class="info.kind === 'sql' ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'"
            >{{ fmtKind(info.kind) }}</span>
          </span>

          <span class="text-dimmed">attach</span>
          <span :class="info.browserAttachEligible ? 'text-success' : 'text-muted'">
            {{ info.browserAttachEligible ? 'browser-attached' : 'server-routed' }}
          </span>

          <span class="text-dimmed">analyzers</span>
          <span class="text-default">
            {{ info.supportedAnalyzerIds.length }}
            <span class="text-dimmed">runnable</span>
          </span>

          <template v-for="(value, key) in (info.identityAttrs ?? {})" :key="key">
            <span class="text-dimmed">{{ key }}</span>
            <span class="text-default truncate" :title="String(value)">{{ String(value) }}</span>
          </template>
        </div>

        <div class="px-3 py-2.5">
          <div class="text-[10px] uppercase tracking-widest text-dimmed font-semibold mb-1.5">
            capabilities
          </div>
          <div class="flex flex-wrap gap-1">
            <template v-for="(value, cap) in info.capabilities" :key="cap">
              <span
                v-if="value"
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-elevated text-muted border border-default"
              >
                {{ cap }}
              </span>
            </template>
            <span
              v-if="!Object.values(info.capabilities).some(Boolean)"
              class="text-[11px] text-dimmed"
            >
              none advertised
            </span>
          </div>
        </div>

        <details class="px-3 py-2.5">
          <summary class="text-[10px] uppercase tracking-widest text-dimmed font-semibold cursor-pointer">
            supported analyzer ids ({{ info.supportedAnalyzerIds.length }})
          </summary>
          <div class="mt-2 max-h-48 overflow-y-auto">
            <div
              v-for="id in info.supportedAnalyzerIds"
              :key="id"
              class="text-[11px] text-muted py-0.5"
            >
              {{ id }}
            </div>
            <div v-if="!info.supportedAnalyzerIds.length" class="text-[11px] text-dimmed">
              none
            </div>
          </div>
        </details>
      </div>
    </div>
  </ClientOnly>
</template>
