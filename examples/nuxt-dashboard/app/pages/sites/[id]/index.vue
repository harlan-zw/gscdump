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
  <GscDashboardPage gap="lg">
    <template #header>
      <GscPageHeader
        :crumbs="[
          { label: 'Overview', to: '/' },
          { label: 'Sites' },
        ]"
        :title="currentSite?.hostname ?? siteId"
        icon="i-lucide-globe"
        description="Search performance across the selected period."
      >
        <template #icon>
          <GscFavicon v-if="currentSite" :domain="currentSite.hostname" :size="18" :alt="currentSite.hostname" />
          <UIcon v-else name="i-lucide-globe" class="size-4 text-dimmed shrink-0" />
        </template>
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
  </GscDashboardPage>
</template>
