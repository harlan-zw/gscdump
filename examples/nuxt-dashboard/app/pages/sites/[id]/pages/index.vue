<script setup lang="ts">
// Pages list for a site — top 100 by clicks in the current window, sourced
// from the shared per-site DuckDB-WASM analyzer over the `pages` Iceberg
// table. Previous-window totals are queried in parallel and joined by URL in
// JS to surface a per-row Δ% clicks badge.

definePageMeta({ key: route => `site-pages-index:${route.params.id}` })

interface TopPageRow { url: string, clicks: number, impressions: number, sum_position: number }
interface PageRowRaw { url: string, clicks: number | bigint, impressions: number | bigint, sum_position: number | bigint }

const { siteId } = useGscCurrentSite()
const { period, compareMode, stableData, range } = useGscPeriod()

// Widest attach window so current + previous slice both run off cached parquet.
const attachRange = computed(() => ({
  start: compareMode.value === 'year'
    ? range.value.yearStart
    : compareMode.value === 'previous'
      ? range.value.prevStart
      : range.value.start,
  end: range.value.end,
}))

const { tables, query, error: analyzerError } = useGscSiteAnalyzer(siteId, attachRange)

const ranges = computed(() => ({
  current: { start: range.value.start, end: range.value.end },
  previous: compareMode.value === 'none'
    ? null
    : compareMode.value === 'year'
      ? { start: range.value.yearStart, end: range.value.yearEnd }
      : { start: range.value.prevStart, end: range.value.prevEnd },
}))

const currentRows = ref<TopPageRow[] | null>(null)
const previousByUrl = ref<Map<string, TopPageRow>>(new Map())

const search = ref('')
const sort = ref<{ column: 'clicks' | 'impressions' | 'position', direction: 'asc' | 'desc' }>({ column: 'clicks', direction: 'desc' })
function toggleSort(column: 'clicks' | 'impressions' | 'position') {
  if (sort.value.column === column)
    sort.value.direction = sort.value.direction === 'desc' ? 'asc' : 'desc'
  else sort.value = { column, direction: 'desc' }
}

async function refresh() {
  if (!siteId.value)
    return
  const r = ranges.value

  query<PageRowRaw>({
    needs: ['pages'],
    sql: `
      SELECT
        url,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM pages
      WHERE date >= DATE '${r.current.start}' AND date <= DATE '${r.current.end}'
      GROUP BY url
      ORDER BY clicks DESC
      LIMIT 100
    `,
  })
    .then((rows) => {
      currentRows.value = rows.map(row => ({
        url: String(row.url),
        clicks: Number(row.clicks),
        impressions: Number(row.impressions),
        sum_position: Number(row.sum_position),
      }))
    })
    .catch(() => { currentRows.value = [] })

  if (r.previous) {
    query<PageRowRaw>({
      needs: ['pages'],
      sql: `
        SELECT
          url,
          SUM(clicks)::DOUBLE AS clicks,
          SUM(impressions)::DOUBLE AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM pages
        WHERE date >= DATE '${r.previous.start}' AND date <= DATE '${r.previous.end}'
        GROUP BY url
      `,
    })
      .then((rows) => {
        const map = new Map<string, TopPageRow>()
        for (const row of rows) {
          map.set(String(row.url), {
            url: String(row.url),
            clicks: Number(row.clicks),
            impressions: Number(row.impressions),
            sum_position: Number(row.sum_position),
          })
        }
        previousByUrl.value = map
      })
      .catch(() => { previousByUrl.value = new Map() })
  }
  else {
    previousByUrl.value = new Map()
  }
}

watch(
  [siteId, () => ranges.value.current.start, () => ranges.value.current.end, () => ranges.value.previous?.start, () => ranges.value.previous?.end],
  refresh,
  { immediate: true },
)

const pagesStage = computed(() => tables.value.pages.stage)
const pagesReady = computed(() => pagesStage.value === 'ready')

interface DisplayRow extends TopPageRow {
  growth: number | null
  position: number
}

const rows = computed<DisplayRow[]>(() => {
  const src = currentRows.value ?? []
  const q = search.value.trim().toLowerCase()
  const prev = previousByUrl.value
  const filtered = q ? src.filter(r => r.url.toLowerCase().includes(q)) : src
  const enriched: DisplayRow[] = filtered.map((r) => {
    const p = prev.get(r.url)
    return {
      ...r,
      position: positionFor(r),
      growth: p ? computeGrowth(r.clicks, p.clicks) : null,
    }
  })
  const dir = sort.value.direction === 'desc' ? -1 : 1
  const col = sort.value.column
  enriched.sort((a, b) => {
    const av = col === 'position' ? a.position : a[col]
    const bv = col === 'position' ? b.position : b[col]
    return av < bv ? -1 * dir : av > bv ? 1 * dir : 0
  })
  return enriched
})

function hrefFor(url: string): string {
  return `/sites/${encodeURIComponent(siteId.value)}/pages/${encodeURIComponent(url)}`
}

function growthColor(g: number | null): 'success' | 'error' | 'neutral' {
  if (g == null || Math.abs(g) < 0.005)
    return 'neutral'
  return g > 0 ? 'success' : 'error'
}
function fmtGrowth(g: number | null): string {
  if (g == null)
    return ''
  const sign = g > 0 ? '+' : ''
  return `${sign}${(g * 100).toFixed(1)}%`
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Pages' }]"
        title="Pages"
        icon="i-lucide-file"
        description="Top 100 pages by clicks over the selected window."
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
        v-model="search"
        icon="i-lucide-search"
        size="sm"
        placeholder="Filter URLs"
        class="flex-1 min-w-[200px]"
      />
      <span v-if="pagesStage !== 'ready'" class="text-[11px] text-dimmed inline-flex items-center gap-1.5">
        <UIcon name="i-lucide-loader" class="size-3 animate-spin" />
        {{ pagesStage === 'downloading' ? `Downloading ${tables.pages.filesAttached}/${tables.pages.filesTotal}` : pagesStage }}
      </span>
      <span class="ml-auto text-[11px] text-dimmed tabular-nums">
        {{ rows.length }} of {{ (currentRows?.length ?? 0).toLocaleString() }}
      </span>
    </div>

    <div
      v-if="pagesReady && currentRows && !currentRows.length"
      class="rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted"
    >
      No pages in the selected window.
    </div>
    <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <tr>
            <th class="px-4 py-2.5 text-left">
              URL
            </th>
            <th class="px-4 py-2.5 text-right w-[110px] cursor-pointer select-none hover:text-default" @click="toggleSort('clicks')">
              Clicks
              <span v-if="sort.column === 'clicks'" class="ml-1">{{ sort.direction === 'desc' ? '↓' : '↑' }}</span>
            </th>
            <th class="px-4 py-2.5 text-right w-[90px]">
              Δ Clicks
            </th>
            <th class="px-4 py-2.5 text-right w-[130px] cursor-pointer select-none hover:text-default" @click="toggleSort('impressions')">
              Impressions
              <span v-if="sort.column === 'impressions'" class="ml-1">{{ sort.direction === 'desc' ? '↓' : '↑' }}</span>
            </th>
            <th class="px-4 py-2.5 text-right w-[100px] cursor-pointer select-none hover:text-default" @click="toggleSort('position')">
              Avg. pos
              <span v-if="sort.column === 'position'" class="ml-1">{{ sort.direction === 'desc' ? '↓' : '↑' }}</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <template v-if="!pagesReady && !currentRows">
            <tr v-for="i in 10" :key="`skeleton-${i}`">
              <td colspan="5" class="px-4 py-2.5">
                <div class="h-5 rounded bg-muted/30 animate-pulse" />
              </td>
            </tr>
          </template>
          <tr
            v-for="(r, i) in rows"
            :key="r.url"
            class="hover:bg-elevated/30 transition-colors"
          >
            <td class="px-4 py-2.5 max-w-[500px]">
              <div class="flex items-center gap-2">
                <span class="text-[11px] tabular-nums text-dimmed w-6 text-right shrink-0">
                  {{ i + 1 }}
                </span>
                <NuxtLink
                  :to="hrefFor(r.url)"
                  class="truncate block text-default hover:text-primary hover:underline"
                  :title="r.url"
                >
                  {{ r.url }}
                </NuxtLink>
              </div>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums">
              {{ r.clicks.toLocaleString() }}
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums">
              <UBadge
                v-if="r.growth != null"
                :color="growthColor(r.growth)"
                variant="soft"
                size="xs"
                class="tabular-nums"
              >
                {{ fmtGrowth(r.growth) }}
              </UBadge>
              <span v-else class="text-dimmed">–</span>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ r.impressions.toLocaleString() }}
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ r.position.toFixed(1) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </GscDashboardPage>
</template>
