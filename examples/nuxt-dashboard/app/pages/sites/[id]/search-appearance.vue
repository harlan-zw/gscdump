<script setup lang="ts">
// Search appearance tab: per-facet breakdown (AMP, rich results, videos, etc.).
// Hits a server endpoint that branches on tier — free tier queries GSC API
// live, pro tier aggregates the `search_appearance` parquet fact table via
// DuckDB. The page doesn't care which backend served the row; same shape.

definePageMeta({ key: route => `site-search-appearance:${route.params.id}` })

const route = useRoute()
const siteId = computed(() => String(route.params.id))
const currentSite = useGscSite(siteId)

type Period = typeof PERIOD_PRESETS[number]['value']
type CompareMode = typeof COMPARE_OPTIONS[number]['value']
const period = ref<Period>('28d')
const compareMode = ref<CompareMode>('none')
const stableData = ref(true)
const range = computed(() => periodToDateRange(period.value, { stableData: stableData.value }))

interface SearchAppearanceRow {
  searchAppearance: string
  clicks: number
  impressions: number
  sum_position: number
}
interface SearchAppearanceResponse {
  rows: SearchAppearanceRow[]
  range: { start: string, end: string }
  generatedAt: string
  source: 'gsc-api' | 'engine'
}

const rows = ref<SearchAppearanceRow[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const bootError = ref<Error | null>(null)

let inFlight: AbortController | null = null

async function load() {
  inFlight?.abort()
  const ctrl = new AbortController()
  inFlight = ctrl
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<SearchAppearanceResponse>(
      `/api/__gsc/sites/${encodeURIComponent(siteId.value)}/search-appearance`,
      { query: { start: range.value.start, end: range.value.end }, signal: ctrl.signal },
    )
    if (ctrl.signal.aborted)
      return
    rows.value = res.rows
  }
  catch (err: unknown) {
    if ((err as { name?: string } | null)?.name === 'AbortError')
      return
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    if (inFlight === ctrl)
      inFlight = null
    loading.value = false
  }
}

watch([siteId, () => range.value.start, () => range.value.end], load, { immediate: true })

const totals = computed(() => {
  let clicks = 0
  let impressions = 0
  for (const r of rows.value) {
    clicks += r.clicks
    impressions += r.impressions
  }
  return { clicks, impressions }
})

const maxClicks = computed(() => rows.value.reduce((m, r) => r.clicks > m ? r.clicks : m, 0) || 1)

function positionFor(r: SearchAppearanceRow): number {
  return r.impressions > 0 ? r.sum_position / r.impressions + 1 : 0
}

function displayName(code: string): string {
  if (!code)
    return ''
  return code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

function iconFor(code: string): string {
  const upper = code.toUpperCase()
  if (upper.startsWith('AMP'))
    return 'i-lucide-zap'
  if (upper.includes('VIDEO'))
    return 'i-lucide-video'
  if (upper.includes('IMAGE'))
    return 'i-lucide-image'
  if (upper.includes('REVIEW'))
    return 'i-lucide-star'
  if (upper.includes('RECIPE'))
    return 'i-lucide-chef-hat'
  if (upper.includes('FAQ') || upper.includes('QA'))
    return 'i-lucide-message-circle-question'
  if (upper.includes('EVENT'))
    return 'i-lucide-calendar'
  if (upper.includes('PRODUCT'))
    return 'i-lucide-shopping-bag'
  if (upper.includes('JOB'))
    return 'i-lucide-briefcase'
  if (upper.includes('BOOK'))
    return 'i-lucide-book'
  if (upper.includes('NEWS') || upper.includes('STORIES'))
    return 'i-lucide-newspaper'
  if (upper.includes('HOWTO'))
    return 'i-lucide-list-checks'
  if (upper.includes('TRANSLATED'))
    return 'i-lucide-languages'
  return 'i-lucide-sparkles'
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscPageHeader
        :crumbs="[
          { label: 'Overview', to: '/' },
          { label: currentSite?.hostname ?? siteId, to: `/sites/${encodeURIComponent(siteId)}` },
          { label: 'Search appearance' },
        ]"
        title="Search appearance"
        icon="i-lucide-sparkles"
        description="Performance by rich-result surface (AMP, reviews, videos, and more)."
      >
        <template #actions>
          <GscDateRangePicker
            v-model:period="period"
            v-model:compare-mode="compareMode"
            v-model:stable-data="stableData"
          />
        </template>
      </GscPageHeader>
    </template>

    <SiteTabs :site-id="siteId" />

    <UAlert
      v-if="bootError"
      color="error"
      icon="i-lucide-alert-circle"
      title="Failed to boot DuckDB-WASM"
      :description="bootError.message"
    />
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-alert-circle"
      :title="error"
    />

    <div v-if="loading && !rows.length" class="text-sm text-muted">
      Loading…
    </div>

    <div
      v-else-if="!rows.length"
      class="rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted"
    >
      <UIcon name="i-lucide-sparkles" class="size-5 text-dimmed mx-auto mb-2" />
      <div class="font-medium text-default mb-1">
        No search-appearance data
      </div>
      <p class="max-w-md mx-auto">
        Google only reports this breakdown when a site earns rich results, AMP impressions, or similar enhanced SERP features. Most sites show nothing here.
      </p>
    </div>

    <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <tr>
            <th class="px-4 py-2.5 text-left">
              Appearance
            </th>
            <th class="px-4 py-2.5 text-left">
              Share
            </th>
            <th class="px-4 py-2.5 text-right w-[110px]">
              Clicks
            </th>
            <th class="px-4 py-2.5 text-right w-[130px]">
              Impressions
            </th>
            <th class="px-4 py-2.5 text-right w-[90px]">
              CTR
            </th>
            <th class="px-4 py-2.5 text-right w-[100px]">
              Avg. pos
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="(r, i) in rows"
            :key="r.searchAppearance"
            class="hover:bg-elevated/30 transition-colors"
          >
            <td class="px-4 py-2.5 max-w-[320px]">
              <div class="flex items-center gap-2">
                <span class="text-[11px] tabular-nums text-dimmed w-5 text-right shrink-0">
                  {{ i + 1 }}
                </span>
                <UIcon :name="iconFor(r.searchAppearance)" class="size-4 text-dimmed shrink-0" />
                <span class="truncate text-default" :title="r.searchAppearance">{{ displayName(r.searchAppearance) }}</span>
                <span class="text-[11px] text-dimmed font-mono shrink-0">{{ r.searchAppearance }}</span>
              </div>
            </td>
            <td class="px-4 py-2.5 min-w-[160px]">
              <div class="flex items-center gap-2">
                <div class="flex-1 h-1.5 rounded-full bg-elevated overflow-hidden">
                  <div
                    class="h-full bg-primary/70 rounded-full"
                    :style="{ width: `${Math.min(100, (r.clicks / maxClicks) * 100)}%` }"
                  />
                </div>
                <span class="text-[11px] tabular-nums text-dimmed shrink-0 w-10 text-right">
                  {{ totals.clicks > 0 ? ((r.clicks / totals.clicks) * 100).toFixed(1) : '0' }}%
                </span>
              </div>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums">
              {{ r.clicks.toLocaleString() }}
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ r.impressions.toLocaleString() }}
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(1) : '0' }}%
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ positionFor(r).toFixed(1) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </GscDashboardPage>
</template>
