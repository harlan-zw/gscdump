<script setup lang="ts">
// Queries list for a site — top 100 by clicks for the current window, sourced
// from the per-site DuckDB-WASM analyzer over the `queries` Iceberg table.
// We pull the previous window in parallel so we can compute Δ% on clicks +
// impressions versus the previous comparison period.

definePageMeta({ key: route => `site-queries-index:${route.params.id}` })

interface TopKeywordRow {
  query: string
  clicks: number
  impressions: number
  sum_position: number
  clicksGrowth: number | null
  impressionsGrowth: number | null
}

interface QueryAggRow { query: string, clicks: number, impressions: number, sum_position: number }

const { siteId } = useGscCurrentSite()
const { period, compareMode, stableData, range } = useGscPeriod()

// Cover the current and previous comparison windows in one attach so Δ%
// queries reuse the cached parquet.
const attachRange = computed(() => ({
  start: compareMode.value === 'year'
    ? range.value.yearStart
    : compareMode.value === 'previous'
      ? range.value.prevStart
      : range.value.start,
  end: range.value.end,
}))

const { tables, query, runQuery, ready, error: analyzerError } = useGscSiteAnalyzer(siteId, attachRange)

const ranges = computed(() => ({
  current: { start: range.value.start, end: range.value.end },
  previous: compareMode.value === 'none'
    ? null
    : compareMode.value === 'year'
      ? { start: range.value.yearStart, end: range.value.yearEnd }
      : { start: range.value.prevStart, end: range.value.prevEnd },
}))

const currentRows = ref<QueryAggRow[] | null>(null)
const previousRows = ref<QueryAggRow[] | null>(null)

async function refresh() {
  if (!siteId.value)
    return
  const r = ranges.value

  query<QueryAggRow>({
    needs: ['queries'],
    sql: `
      SELECT
        query,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM queries
      WHERE date >= DATE '${r.current.start}' AND date <= DATE '${r.current.end}'
      GROUP BY query
      ORDER BY clicks DESC
      LIMIT 100
    `,
  })
    .then((rows) => {
      currentRows.value = rows.map(r => ({
        query: String(r.query),
        clicks: Number(r.clicks),
        impressions: Number(r.impressions),
        sum_position: Number(r.sum_position),
      }))
    })
    .catch(() => { currentRows.value = [] })

  if (r.previous) {
    query<QueryAggRow>({
      needs: ['queries'],
      sql: `
        SELECT
          query,
          SUM(clicks)::DOUBLE AS clicks,
          SUM(impressions)::DOUBLE AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM queries
        WHERE date >= DATE '${r.previous.start}' AND date <= DATE '${r.previous.end}'
        GROUP BY query
        ORDER BY clicks DESC
        LIMIT 100
      `,
    })
      .then((rows) => {
        previousRows.value = rows.map(r => ({
          query: String(r.query),
          clicks: Number(r.clicks),
          impressions: Number(r.impressions),
          sum_position: Number(r.sum_position),
        }))
      })
      .catch(() => { previousRows.value = [] })
  }
  else {
    previousRows.value = null
  }
}

watch(
  [siteId, () => ranges.value.current.start, () => ranges.value.current.end, () => ranges.value.previous?.start, () => ranges.value.previous?.end, ready],
  refresh,
  { immediate: true },
)

// Materialised rows: current window enriched with per-keyword Δ% vs previous.
const materialised = computed<TopKeywordRow[]>(() => {
  const cur = currentRows.value ?? []
  const prev = previousRows.value
  const prevMap = new Map<string, QueryAggRow>()
  if (prev) {
    for (const p of prev)
      prevMap.set(p.query, p)
  }
  return cur.map((c) => {
    const p = prevMap.get(c.query) ?? null
    return {
      query: c.query,
      clicks: c.clicks,
      impressions: c.impressions,
      sum_position: c.sum_position,
      clicksGrowth: p ? computeGrowth(c.clicks, p.clicks) : null,
      impressionsGrowth: p ? computeGrowth(c.impressions, p.impressions) : null,
    }
  })
})

// ── filter + sort UI (client-side over the materialised set) ──────────────
const q = ref('')
type SortColumn = 'clicks' | 'impressions' | 'position'
const sort = ref<{ column: SortColumn, direction: 'asc' | 'desc' } | null>({ column: 'clicks', direction: 'desc' })

function toggleSort(column: SortColumn) {
  const cur = sort.value
  if (cur?.column === column)
    sort.value = { column, direction: cur.direction === 'desc' ? 'asc' : 'desc' }
  else
    sort.value = { column, direction: 'desc' }
}

const rows = computed<TopKeywordRow[]>(() => {
  const needle = q.value.trim().toLowerCase()
  let out = materialised.value
  if (needle)
    out = out.filter(r => r.query.toLowerCase().includes(needle))
  const s = sort.value
  if (s) {
    const dir = s.direction === 'desc' ? -1 : 1
    const col = s.column
    out = [...out].sort((a, b) => {
      const av = col === 'position' ? positionFor(a) : a[col]
      const bv = col === 'position' ? positionFor(b) : b[col]
      return av === bv ? 0 : av < bv ? -1 * dir : 1 * dir
    })
  }
  return out
})

const queriesStage = computed(() => tables.value.queries.stage)
const isLoading = computed(() => queriesStage.value !== 'ready' && queriesStage.value !== 'unavailable')
const semanticSeed = computed(() => q.value.trim() || rows.value[0]?.query || '')

function hrefFor(keyword: string): string {
  return `/sites/${encodeURIComponent(siteId.value)}/queries/${encodeURIComponent(keyword)}`
}

function fmtGrowth(g: number | null): string {
  if (g == null)
    return ''
  const sign = g > 0 ? '+' : ''
  return `${sign}${(g * 100).toFixed(1)}%`
}
function growthColor(g: number | null): 'success' | 'error' | 'neutral' {
  if (g == null || Math.abs(g) < 0.005)
    return 'neutral'
  return g > 0 ? 'success' : 'error'
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Queries' }]"
        title="Queries"
        icon="i-lucide-search"
        description="Top 100 keywords by clicks over the selected window."
      >
        <template #actions>
          <GscDateRangePicker
            v-model:period="period"
            v-model:compare-mode="compareMode"
            v-model:stable-data="stableData"
          />
        </template>
      </GscSitePageHeader>
    </template>

    <SiteTabs :site-id="siteId" />

    <UAlert
      v-if="analyzerError"
      color="error"
      icon="i-lucide-alert-circle"
      :title="`Analyzer error: ${analyzerError.message}`"
    />

    <div class="flex items-center gap-3 flex-wrap rounded-lg border border-default bg-default px-3 py-2">
      <UInput
        v-model="q"
        icon="i-lucide-search"
        size="sm"
        placeholder="Filter queries"
        class="flex-1 min-w-[200px]"
      />
      <span class="ml-auto text-[11px] text-dimmed tabular-nums">
        {{ rows.length }} of {{ (materialised.length).toLocaleString() }}
      </span>
    </div>

    <PanelsSemanticKeywordRepoPanel
      :runner="{ query: runQuery }"
      :ready="ready"
      :range="ranges.current"
      :seed="semanticSeed"
      title="Semantically related queries"
      :limit="8"
    />

    <div v-if="isLoading && !materialised.length" class="rounded-lg border border-default bg-default overflow-hidden">
      <div class="space-y-2 p-3">
        <div v-for="i in 8" :key="i" class="h-6 rounded bg-muted/30 animate-pulse" />
      </div>
    </div>
    <div
      v-else-if="queriesStage === 'unavailable' || !materialised.length"
      class="rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted"
    >
      No queries in range.
    </div>
    <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <tr>
            <th class="px-4 py-2.5 text-left">
              Query
            </th>
            <th class="px-4 py-2.5 text-right w-[110px] cursor-pointer select-none hover:text-default" @click="toggleSort('clicks')">
              Clicks
              <span v-if="sort?.column === 'clicks'" class="ml-1">{{ sort.direction === 'desc' ? '↓' : '↑' }}</span>
            </th>
            <th class="px-4 py-2.5 text-right w-[90px]">
              Δ clicks
            </th>
            <th class="px-4 py-2.5 text-right w-[130px] cursor-pointer select-none hover:text-default" @click="toggleSort('impressions')">
              Impressions
              <span v-if="sort?.column === 'impressions'" class="ml-1">{{ sort.direction === 'desc' ? '↓' : '↑' }}</span>
            </th>
            <th class="px-4 py-2.5 text-right w-[100px] cursor-pointer select-none hover:text-default" @click="toggleSort('position')">
              Avg. pos
              <span v-if="sort?.column === 'position'" class="ml-1">{{ sort.direction === 'desc' ? '↓' : '↑' }}</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="(r, i) in rows"
            :key="r.query"
            class="hover:bg-elevated/30 transition-colors"
          >
            <td class="px-4 py-2.5 max-w-[500px]">
              <div class="flex items-center gap-2">
                <span class="text-[11px] tabular-nums text-dimmed w-6 text-right">
                  {{ i + 1 }}
                </span>
                <GscQueryLabel :keyword="r.query" :position="positionFor(r)" :href="hrefFor(r.query)" />
              </div>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums">
              {{ r.clicks.toLocaleString() }}
            </td>
            <td class="px-4 py-2.5 text-right">
              <UBadge
                v-if="r.clicksGrowth != null"
                :color="growthColor(r.clicksGrowth)"
                variant="soft"
                size="xs"
                class="tabular-nums"
              >
                {{ fmtGrowth(r.clicksGrowth) }}
              </UBadge>
              <span v-else class="text-dimmed text-[11px]">–</span>
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
  </GscDashboardPage>
</template>
