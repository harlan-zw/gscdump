<script setup lang="ts">
// Page detail: daily series for one URL + list of queries ranking for it.
// Data comes from the shared per-site DuckDB-WASM analyzer:
//   - daily series from the `pages` Iceberg table filtered to `url`
//   - top queries from the `page_queries` Iceberg table filtered to `url`

definePageMeta({ key: route => `page-detail:${route.params.id}:${route.params.page}` })

const route = useRoute()
const { siteId, site: currentSite } = useGscCurrentSite()
const pagePath = computed(() => decodeURIComponent(String(route.params.page)))

const { period, compareMode, stableData, range } = useGscPeriod()

interface DailyRowRaw { date: string, clicks: number | bigint, impressions: number | bigint, sum_position: number | bigint }
interface QueryRowRaw { query: string, clicks: number | bigint, impressions: number | bigint, sum_position: number | bigint }
interface DailyRow { date: string, clicks: number, impressions: number, sum_position: number }
interface QueryRowShape { query: string, clicks: number, impressions: number, sum_position: number }

const attachRange = computed(() => ({ start: range.value.start, end: range.value.end }))

const { tables, query, error: analyzerError } = useGscAnalyzerQuery(siteId, attachRange)

const dailyRaw = ref<DailyRow[]>([])
const queriesRaw = ref<QueryRowShape[]>([])
const dailyLoaded = ref(false)
const queriesLoaded = ref(false)

function escapeSql(s: string): string {
  return s.replace(/'/g, '\'\'')
}

async function refresh() {
  if (!siteId.value || !pagePath.value)
    return
  const url = escapeSql(pagePath.value)
  const r = range.value

  dailyLoaded.value = false
  query<DailyRowRaw>({
    needs: ['pages'],
    sql: `
      SELECT
        CAST(date AS VARCHAR) AS date,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM pages
      WHERE url = '${url}'
        AND date >= DATE '${r.start}' AND date <= DATE '${r.end}'
      GROUP BY date
      ORDER BY date
    `,
  })
    .then((rows) => {
      dailyRaw.value = rows.map(row => ({
        date: String(row.date),
        clicks: Number(row.clicks),
        impressions: Number(row.impressions),
        sum_position: Number(row.sum_position),
      }))
    })
    .catch(() => { dailyRaw.value = [] })
    .finally(() => { dailyLoaded.value = true })

  queriesLoaded.value = false
  query<QueryRowRaw>({
    needs: ['page_queries'],
    sql: `
      SELECT
        query,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM page_queries
      WHERE url = '${url}'
        AND date >= DATE '${r.start}' AND date <= DATE '${r.end}'
      GROUP BY query
      ORDER BY clicks DESC
      LIMIT 50
    `,
  })
    .then((rows) => {
      queriesRaw.value = rows.map(row => ({
        query: String(row.query),
        clicks: Number(row.clicks),
        impressions: Number(row.impressions),
        sum_position: Number(row.sum_position),
      }))
    })
    .catch(() => { queriesRaw.value = [] })
    .finally(() => { queriesLoaded.value = true })
}

watch([siteId, pagePath, () => range.value.start, () => range.value.end], refresh, { immediate: true })

const summary = computed(() => summarizeDailyRows(dailyRaw.value))
const totals = computed(() => summary.value.totals)
const chartData = computed(() => summary.value.chartData)
const queries = computed(() => queriesRaw.value.map(coerceRowMetrics))

const pagesStage = computed(() => tables.value.pages.stage)
const pageQueriesStage = computed(() => tables.value.page_queries.stage)
const dailyReady = computed(() => pagesStage.value === 'ready' && dailyLoaded.value)
const queriesReady = computed(() => pageQueriesStage.value === 'ready' && queriesLoaded.value)

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
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[
          { label: 'Pages', to: `/sites/${encodeURIComponent(siteId)}/pages` },
          { label: pagePath },
        ]"
        :title="pagePath"
        icon="i-lucide-file"
      >
        <template #actions>
          <UButton
            :to="pagePath"
            target="_blank"
            size="xs"
            color="neutral"
            variant="ghost"
            trailing-icon="i-lucide-external-link"
          >
            Open
          </UButton>
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
        </template>
      </GscSitePageHeader>
    </template>

    <UAlert
      v-if="analyzerError"
      color="error"
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
          <template v-if="dailyReady">
            {{ stat.value }}
          </template>
          <span v-else class="inline-block w-20 h-7 rounded bg-muted/30 animate-pulse" />
        </div>
      </div>
    </div>

    <div v-if="chartData.length" class="rounded-lg border border-default bg-default p-4">
      <GscPerformanceChart :value="chartData" :height="220" />
    </div>
    <div v-else-if="!dailyReady" class="rounded-lg border border-default bg-default p-4">
      <div class="h-[220px] rounded bg-muted/20 animate-pulse" />
    </div>

    <div>
      <h3 class="text-sm font-semibold tracking-tight text-default mb-2">
        Ranking queries
      </h3>
      <div
        v-if="!queriesReady && !queries.length"
        class="rounded-lg border border-default bg-default overflow-hidden"
      >
        <div class="p-3 space-y-2">
          <div v-for="i in 6" :key="i" class="h-5 rounded bg-muted/30 animate-pulse" />
        </div>
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
  </GscDashboardPage>
</template>
