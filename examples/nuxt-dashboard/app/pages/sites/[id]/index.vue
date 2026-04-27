<script setup lang="ts">
// Site hero page: stats + 28d performance chart + top queries/pages previews.
// Reads directly from the `daily_totals` + `top_*_28d` rollups — no DuckDB
// boot required. The full analyzer playground lives at /sites/[id]/analyze.

definePageMeta({ key: route => `site-overview:${route.params.id}` })

interface DailyTotal {
  date: number
  clicks: number
  impressions: number
  sum_position: number
  anonymizedImpressionsPct: number
}

interface TopPageRow { url: string, clicks: number, impressions: number, sum_position: number }
interface TopKeywordRow { query: string, clicks: number, impressions: number, sum_position: number }

const route = useRoute()
const siteId = computed(() => String(route.params.id))

const currentSite = useGscSite(siteId)

type Period = typeof PERIOD_PRESETS[number]['value']
type CompareMode = typeof COMPARE_OPTIONS[number]['value']
const period = ref<Period>('28d')
const compareMode = ref<CompareMode>('previous')
const stableData = ref(true)
const range = computed(() => periodToDateRange(period.value, stableData.value))

const windowRange = computed(() => ({ start: range.value.start, end: range.value.end }))
const { payload, loading } = useGscRollups<unknown>(
  siteId,
  ['daily_totals', 'top_pages_28d', 'top_keywords_28d'],
  { range: windowRange },
)

const dailyPayload = computed(() => payload('daily_totals') as DailyTotal[] | null)
const topPages = computed(() => payload('top_pages_28d') as TopPageRow[] | null)
const topKeywords = computed(() => payload('top_keywords_28d') as TopKeywordRow[] | null)

const topPageRows = computed(() => (topPages.value ?? []).slice(0, 10).map(r => ({
  label: r.url,
  metric: r.clicks,
  secondary: `${r.impressions.toLocaleString()} impr`,
})))

const topKeywordRows = computed(() => (topKeywords.value ?? []).slice(0, 10).map(r => ({
  label: r.query,
  metric: r.clicks,
  secondary: `${r.impressions.toLocaleString()} impr`,
})))
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <header class="max-w-[1128px] px-4 sm:px-6 lg:px-9 border-b border-default pb-3">
      <div class="flex items-start gap-4 pt-5">
        <div class="flex flex-col sm:flex-row justify-between min-w-0 w-full gap-3 sm:gap-0">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-xs text-dimmed mb-1">
              <NuxtLink to="/" class="hover:text-default">
                Overview
              </NuxtLink>
              <UIcon name="i-lucide-chevron-right" class="size-3" />
              <span class="text-muted">Sites</span>
            </div>
            <h1 class="text-xl font-semibold tracking-tight text-default flex items-center gap-2">
              <GscFavicon v-if="currentSite" :domain="currentSite.hostname" :size="18" :alt="currentSite.hostname" />
              <UIcon v-else name="i-lucide-globe" class="size-4 text-dimmed" />
              {{ currentSite?.hostname ?? siteId }}
            </h1>
            <p class="text-[13px] text-muted mt-0.5 leading-snug">
              Search performance across the selected period.
            </p>
          </div>
          <div class="flex items-center gap-3 flex-wrap">
            <GscDateRangePicker
              v-model:period="period"
              v-model:compare-mode="compareMode"
              v-model:stable-data="stableData"
            />
          </div>
        </div>
      </div>
    </header>

    <div class="max-w-[1128px] px-4 sm:px-6 lg:px-9 pt-4 pb-10 flex flex-col gap-5 flex-1 w-full">
      <SiteTabs :site-id="siteId" />

      <div v-if="loading && !dailyPayload" class="text-sm text-muted">
        Loading…
      </div>

      <GscHero
        :payload="dailyPayload"
        :range="range"
        :compare-mode="compareMode"
      />

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GscDataList
          title="Top queries"
          description="Last 28 days · from top_keywords_28d rollup"
          :rows="topKeywordRows"
          empty="No keyword rollup built yet."
        />
        <GscDataList
          title="Top pages"
          description="Last 28 days · from top_pages_28d rollup"
          :rows="topPageRows"
          empty="No page rollup built yet."
        />
      </div>
    </div>
  </div>
</template>
