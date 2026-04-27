<script setup lang="ts">
// Page detail: daily series for one URL + list of queries ranking for it.
// Data comes from POST /api/__gsc/sites/[siteId]/rows which dispatches against the
// viewer's source (GSC API in free tier, engine in pro). No client-side
// DuckDB boot required.

import { between, clicks as clicksCol, date as dateDim, eq, gsc, page as pageDim, query as queryDim } from 'gscdump/query'

definePageMeta({ key: route => `page-detail:${route.params.id}:${route.params.page}` })

const route = useRoute()
const siteId = computed(() => String(route.params.id))
const pagePath = computed(() => decodeURIComponent(String(route.params.page)))
const currentSite = useGscSite(siteId)

type Period = typeof PERIOD_PRESETS[number]['value']
type CompareMode = typeof COMPARE_OPTIONS[number]['value']
const period = ref<Period>('28d')
const compareMode = ref<CompareMode>('none')
const stableData = ref(true)
const range = computed(() => periodToDateRange(period.value, stableData.value))

interface DailyRow { date: string, clicks: number, impressions: number, sum_position?: number, position?: number }
interface QueryRowShape { query: string, clicks: number, impressions: number, sum_position?: number, position?: number }

const bootError = ref<Error | null>(null)

// Daily series filtered to this single URL.
const dailyState = computed(() => {
  if (!pagePath.value)
    return null
  return gsc
    .select(dateDim)
    .where(eq(pageDim, pagePath.value))
    .where(between(dateDim, range.value.start, range.value.end))
    .getState()
})

// Top queries ranking for this URL.
const topQueriesState = computed(() => {
  if (!pagePath.value)
    return null
  return gsc
    .select(queryDim)
    .where(eq(pageDim, pagePath.value))
    .where(between(dateDim, range.value.start, range.value.end))
    .orderBy(clicksCol, 'desc')
    .limit(100)
    .getState()
})

const { rows: dailyRaw, loading: dailyLoading, error: dailyError } = useGscRowQuery<DailyRow>({
  site: siteId,
  state: dailyState,
})
const { rows: queriesRaw, loading: queriesLoading, error: queriesError } = useGscRowQuery<QueryRowShape>({
  site: siteId,
  state: topQueriesState,
})

const daily = computed(() => dailyRaw.value
  .slice()
  .sort((a, b) => a.date.localeCompare(b.date))
  .map(r => ({
    date: r.date,
    clicks: r.clicks,
    impressions: r.impressions,
    sum_position: r.sum_position ?? (r.position ?? 0) * r.impressions,
  })))

const queries = computed(() => queriesRaw.value.map(r => ({
  query: r.query,
  clicks: r.clicks,
  impressions: r.impressions,
  sum_position: r.sum_position ?? (r.position ?? 0) * r.impressions,
})))

const loading = computed(() => dailyLoading.value || queriesLoading.value)
const error = computed(() => dailyError.value?.message ?? queriesError.value?.message ?? null)

const totals = computed(() => {
  let clicks = 0
  let impressions = 0
  let weightedPosition = 0
  for (const d of daily.value) {
    clicks += d.clicks
    impressions += d.impressions
    weightedPosition += d.sum_position
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions + 1 : 0,
  }
})

function positionFor(r: { impressions: number, sum_position: number }): number {
  return r.impressions > 0 ? r.sum_position / r.impressions + 1 : 0
}

const chartData = computed(() => daily.value.map(d => ({
  date: d.date,
  clicks: d.clicks,
  impressions: d.impressions,
})))

const gscLink = computed(() =>
  currentSite.value
    ? gscConsoleUrl({
        siteLabel: currentSite.value.label,
        page: pagePath.value,
        resource: 'performance',
      })
    : null,
)

const inspectLink = computed(() =>
  currentSite.value
    ? gscConsoleUrl({
        siteLabel: currentSite.value.label,
        page: pagePath.value,
        resource: 'url-inspection',
      })
    : null,
)
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
              <NuxtLink :to="`/sites/${encodeURIComponent(siteId)}`" class="hover:text-default">
                {{ currentSite?.hostname ?? siteId }}
              </NuxtLink>
              <UIcon name="i-lucide-chevron-right" class="size-3" />
              <NuxtLink :to="`/sites/${encodeURIComponent(siteId)}/pages`" class="hover:text-default">
                Pages
              </NuxtLink>
              <UIcon name="i-lucide-chevron-right" class="size-3" />
              <span class="text-muted truncate max-w-[300px]">{{ pagePath }}</span>
            </div>
            <h1 class="text-xl font-semibold tracking-tight text-default flex items-center gap-2">
              <UIcon name="i-lucide-file" class="size-4 text-dimmed shrink-0" />
              <span class="truncate">{{ pagePath }}</span>
            </h1>
            <a :href="pagePath" target="_blank" class="text-[11px] text-dimmed hover:text-primary inline-flex items-center gap-1 mt-1">
              open <UIcon name="i-lucide-external-link" class="size-3" />
            </a>
          </div>
          <div class="flex items-center gap-2 flex-wrap shrink-0">
            <UButton
              v-if="inspectLink"
              :to="inspectLink"
              target="_blank"
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-search-code"
            >
              Inspect URL
            </UButton>
            <UButton
              v-if="gscLink"
              :to="gscLink"
              target="_blank"
              size="xs"
              color="neutral"
              variant="outline"
              trailing-icon="i-lucide-external-link"
            >
              Open in GSC
            </UButton>
            <GscDateRangePicker
              v-model:period="period"
              v-model:compare-mode="compareMode"
              v-model:stable-data="stableData"
            />
          </div>
        </div>
      </div>
    </header>

    <div class="max-w-[1128px] px-4 sm:px-6 lg:px-9 pt-4 pb-10 flex flex-col gap-4 flex-1 w-full">
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

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div
          v-for="stat in [
            { label: 'Clicks', value: totals.clicks.toLocaleString(), icon: 'i-lucide-mouse-pointer-click' },
            { label: 'Impressions', value: totals.impressions.toLocaleString(), icon: 'i-lucide-eye' },
            { label: 'CTR', value: `${(totals.ctr * 100).toFixed(2)}%`, icon: 'i-lucide-percent' },
            { label: 'Avg. position', value: totals.position > 0 ? totals.position.toFixed(1) : '–', icon: 'i-lucide-hash' },
          ]"
          :key="stat.label"
          class="rounded-lg border border-default bg-default p-4"
        >
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon :name="stat.icon" class="size-3" />
            {{ stat.label }}
          </div>
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
            {{ stat.value }}
          </div>
        </div>
      </div>

      <div v-if="chartData.length" class="rounded-lg border border-default bg-default p-4">
        <GscPerformanceChart :value="chartData" :height="220" />
      </div>

      <div>
        <h3 class="text-sm font-semibold tracking-tight text-default mb-2">
          Ranking queries
        </h3>
        <div
          v-if="loading && !queries.length"
          class="rounded-lg border border-default bg-default p-6 text-sm text-muted"
        >
          Loading…
        </div>
        <div
          v-else-if="!queries.length"
          class="rounded-lg border border-dashed border-default p-6 text-sm text-muted text-center"
        >
          No queries recorded for this page in the selected period.
        </div>
        <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
              <tr>
                <th class="px-4 py-2.5 text-left">
                  Query
                </th>
                <th class="px-4 py-2.5 text-right w-[110px]">
                  Clicks
                </th>
                <th class="px-4 py-2.5 text-right w-[130px]">
                  Impressions
                </th>
                <th class="px-4 py-2.5 text-right w-[100px]">
                  Avg. pos
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="r in queries" :key="r.query" class="hover:bg-elevated/30 transition-colors">
                <td class="px-4 py-2.5 max-w-[500px]">
                  <GscQueryLabel
                    :keyword="r.query"
                    :position="positionFor(r)"
                    :href="`/sites/${encodeURIComponent(siteId)}/queries/${encodeURIComponent(r.query)}`"
                  />
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums">
                  {{ r.clicks.toLocaleString() }}
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums text-muted">
                  {{ r.impressions.toLocaleString() }}
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums text-muted">
                  {{ positionFor(r).toFixed(1) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
