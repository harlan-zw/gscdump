<script setup lang="ts">
// Query detail: daily series for one keyword from the `queries` Iceberg table
// plus the ranking pages from `page_queries`. Both queries dispatch through
// the shared per-site DuckDB-WASM analyzer, so navigating in from the queries
// list reuses the already-attached parquet.

definePageMeta({ key: route => `query-detail:${route.params.id}:${route.params.keyword}` })

const route = useRoute()
const { siteId, site: currentSite } = useGscCurrentSite()
const keyword = computed(() => decodeURIComponent(String(route.params.keyword)))

const { period, compareMode, stableData, range } = useGscPeriod()

interface DailyAggRow { date: string, clicks: number, impressions: number, sum_position: number }
interface PageAggRow { url: string, clicks: number, impressions: number, sum_position: number }

const attachRange = computed(() => ({ start: range.value.start, end: range.value.end }))

const { tables, query, error: analyzerError } = useGscSiteAnalyzer(siteId, attachRange)

const dailyRows = ref<DailyAggRow[] | null>(null)
const pageRows = ref<PageAggRow[] | null>(null)

function escapeLiteral(s: string): string {
  return s.replace(/'/g, '\'\'')
}

async function refresh() {
  if (!siteId.value || !keyword.value)
    return
  const r = range.value
  const kw = escapeLiteral(keyword.value)

  query<{ date: string, clicks: number, impressions: number, sum_position: number }>({
    needs: ['queries'],
    sql: `
      SELECT
        CAST(date AS VARCHAR) AS date,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM queries
      WHERE query = '${kw}'
        AND date >= DATE '${r.start}' AND date <= DATE '${r.end}'
      GROUP BY date
      ORDER BY date
    `,
  })
    .then((rows) => {
      dailyRows.value = rows.map(d => ({
        date: String(d.date),
        clicks: Number(d.clicks),
        impressions: Number(d.impressions),
        sum_position: Number(d.sum_position),
      }))
    })
    .catch(() => { dailyRows.value = [] })

  query<{ url: string, clicks: number, impressions: number, sum_position: number }>({
    needs: ['page_queries'],
    sql: `
      SELECT
        url,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM page_queries
      WHERE query = '${kw}'
        AND date >= DATE '${r.start}' AND date <= DATE '${r.end}'
      GROUP BY url
      ORDER BY clicks DESC
      LIMIT 50
    `,
  })
    .then((rows) => {
      pageRows.value = rows.map(p => ({
        url: String(p.url),
        clicks: Number(p.clicks),
        impressions: Number(p.impressions),
        sum_position: Number(p.sum_position),
      }))
    })
    .catch(() => { pageRows.value = [] })
}

watch(
  [siteId, keyword, () => range.value.start, () => range.value.end],
  refresh,
  { immediate: true },
)

const summary = computed(() => summarizeDailyRows(dailyRows.value ?? []))
const totals = computed(() => summary.value.totals)
const chartData = computed(() => summary.value.chartData)
const pages = computed(() => pageRows.value ?? [])

const queriesStage = computed(() => tables.value.queries.stage)
const pageQueriesStage = computed(() => tables.value.page_queries.stage)
const dailyLoading = computed(() => queriesStage.value !== 'ready' && queriesStage.value !== 'unavailable')
const pagesLoading = computed(() => pageQueriesStage.value !== 'ready' && pageQueriesStage.value !== 'unavailable')

const gscLink = computed(() =>
  currentSite.value
    ? gscConsoleUrl({
        siteLabel: currentSite.value.label,
        query: keyword.value,
        resource: 'performance',
      })
    : null,
)
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[
          { label: 'Queries', to: `/sites/${encodeURIComponent(siteId)}/queries` },
          { label: keyword },
        ]"
        :title="keyword"
        icon="i-lucide-search"
      >
        <template #actions>
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
        </template>
      </GscSitePageHeader>
    </template>

    <UAlert
      v-if="analyzerError"
      color="error"
      variant="soft"
      icon="i-lucide-alert-circle"
      :title="`Analyzer error: ${analyzerError.message}`"
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
          <template v-if="!dailyLoading || dailyRows">
            {{ stat.value }}
          </template>
          <span v-else class="inline-block w-16 h-6 rounded bg-muted/40 animate-pulse" />
        </div>
      </div>
    </div>

    <div v-if="chartData.length" class="rounded-lg border border-default bg-default p-4">
      <GscPerformanceChart :value="chartData" :height="220" />
    </div>
    <div v-else-if="dailyLoading" class="rounded-lg border border-default bg-default p-4">
      <div class="h-[220px] rounded bg-muted/20 animate-pulse" />
    </div>

    <div>
      <h3 class="text-sm font-semibold tracking-tight text-default mb-2">
        Ranking pages
      </h3>
      <div
        v-if="pagesLoading && !pages.length"
        class="rounded-lg border border-default bg-default overflow-hidden"
      >
        <div class="space-y-2 p-3">
          <div v-for="i in 6" :key="i" class="h-6 rounded bg-muted/30 animate-pulse" />
        </div>
      </div>
      <div
        v-else-if="!pages.length"
        class="rounded-lg border border-dashed border-default p-6 text-sm text-muted text-center"
      >
        No pages recorded for this query in the selected period.
      </div>
      <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <tr>
              <th class="px-4 py-2.5 text-left">
                URL
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
            <tr v-for="r in pages" :key="r.url" class="hover:bg-elevated/30 transition-colors">
              <td class="px-4 py-2.5 max-w-[500px]">
                <NuxtLink
                  :to="`/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(r.url)}`"
                  class="truncate block text-default hover:text-primary hover:underline"
                  :title="r.url"
                >
                  {{ r.url }}
                </NuxtLink>
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
  </GscDashboardPage>
</template>
