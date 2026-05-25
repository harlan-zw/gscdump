<script setup lang="ts">
// Site overview page. All data comes from the per-site DuckDB-WASM analyzer
// over the Iceberg fact tables — daily totals from `dates`, top pages from
// `pages`, top keywords from `queries`. The analyzer is shared across every
// subpage under `/sites/[id]/*`, so by the time the user clicks into Queries
// or Pages the DB + parquet are already in memory and the table renders in
// ~50ms instead of refetching.

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

const { siteId, site: currentSite } = useGscCurrentSite()
const { period, compareMode, stableData, range } = useGscPeriod()

// The attach range is the widest window we'll query — pulls the previous
// period plus the current one so Δ% queries hit cached parquet without a
// second analysis-sources roundtrip.
const attachRange = computed(() => ({
  start: compareMode.value === 'year'
    ? range.value.yearStart
    : compareMode.value === 'previous'
      ? range.value.prevStart
      : range.value.start,
  end: range.value.end,
}))

const { tables, query, ready, error: analyzerError } = useGscAnalyzerQuery(siteId, attachRange)
const { envelopes: dailyEnvelopes } = useDailyTotalsFromIceberg(
  computed(() => siteId.value ? [{ id: siteId.value }] : []),
  { range: attachRange, useOpfsCache: false },
)

const ranges = computed(() => ({
  current: { start: range.value.start, end: range.value.end },
  previous: compareMode.value === 'none'
    ? null
    : compareMode.value === 'year'
      ? { start: range.value.yearStart, end: range.value.yearEnd }
      : { start: range.value.prevStart, end: range.value.prevEnd },
}))

interface DailyRow { date: string, clicks: number, impressions: number, sum_position: number, anonymized_impressions_pct: number }

const dailyPayload = ref<DailyTotal[] | null>(null)
const dailyLoading = ref(false)

const topPages = ref<TopPageRow[] | null>(null)
const topPagesLoading = ref(false)

const topKeywords = ref<TopKeywordRow[] | null>(null)
const topKeywordsLoading = ref(false)

interface Totals { clicks: number, impressions: number, sum_position: number, days: number }
const currentTotals = ref<Totals | null>(null)
const previousTotals = ref<Totals | null>(null)

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function summarizeDailyTotals(payload: DailyTotal[], start: string, end: string): Totals | null {
  let clicks = 0
  let impressions = 0
  let sumPosition = 0
  let days = 0
  for (const row of payload) {
    const iso = toIso(row.date)
    if (iso < start || iso > end)
      continue
    clicks += row.clicks
    impressions += row.impressions
    sumPosition += row.sum_position
    days++
  }
  return days > 0 ? { clicks, impressions, sum_position: sumPosition, days } : null
}

watch(
  [() => dailyEnvelopes.value[siteId.value]?.payload, ranges],
  () => {
    const payload = dailyEnvelopes.value[siteId.value]?.payload ?? null
    if (!payload)
      return
    dailyPayload.value = payload
    currentTotals.value = summarizeDailyTotals(payload, ranges.value.current.start, ranges.value.current.end)
    previousTotals.value = ranges.value.previous
      ? summarizeDailyTotals(payload, ranges.value.previous.start, ranges.value.previous.end)
      : null
  },
  { immediate: true },
)

async function refresh() {
  if (!siteId.value)
    return
  const r = ranges.value

  // Per-card fetches run in parallel — they all attach `dates` / `pages` /
  // `queries` lazily through the shared analyzer, so once one card has
  // triggered the attach, the others are basically free.

  // ── daily timeseries (drives the chart) ──────────────────────────────
  dailyLoading.value = true
  query<DailyRow>({
    needs: ['dates'],
    sql: `
      SELECT
        CAST(date AS VARCHAR) AS date,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position,
        AVG(anonymized_impressions_pct)::DOUBLE AS anonymized_impressions_pct
      FROM dates
      WHERE date >= DATE '${r.current.start}' AND date <= DATE '${r.current.end}'
      GROUP BY date
      ORDER BY date
    `,
  })
    .then((rows) => {
      dailyPayload.value = rows.map(row => ({
        date: Date.parse(`${row.date}T00:00:00Z`),
        clicks: Number(row.clicks),
        impressions: Number(row.impressions),
        sum_position: Number(row.sum_position),
        anonymizedImpressionsPct: Number(row.anonymized_impressions_pct) || 0,
      }))
    })
    .catch(() => { dailyPayload.value = [] })
    .finally(() => { dailyLoading.value = false })

  // ── KPI totals (current + previous for Δ%) ──────────────────────────
  query<{ clicks: number, impressions: number, sum_position: number, days: number }>({
    needs: ['dates'],
    sql: `
      SELECT
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position,
        COUNT(*)::INTEGER AS days
      FROM dates
      WHERE date >= DATE '${r.current.start}' AND date <= DATE '${r.current.end}'
    `,
  })
    .then((rows) => {
      currentTotals.value = rows[0] ?? null
    })
    .catch(() => {
      currentTotals.value = null
    })

  if (r.previous) {
    query<{ clicks: number, impressions: number, sum_position: number, days: number }>({
      needs: ['dates'],
      sql: `
        SELECT
          SUM(clicks)::DOUBLE AS clicks,
          SUM(impressions)::DOUBLE AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position,
          COUNT(*)::INTEGER AS days
        FROM dates
        WHERE date >= DATE '${r.previous.start}' AND date <= DATE '${r.previous.end}'
      `,
    })
      .then((rows) => {
        previousTotals.value = rows[0] ?? null
      })
      .catch(() => { previousTotals.value = null })
  }
  else {
    previousTotals.value = null
  }

  // ── top 10 pages (by clicks, in current window) ─────────────────────
  topPagesLoading.value = true
  query<TopPageRow>({
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
      LIMIT 10
    `,
  })
    .then((rows) => {
      topPages.value = rows.map(r => ({ url: String(r.url), clicks: Number(r.clicks), impressions: Number(r.impressions), sum_position: Number(r.sum_position) }))
    })
    .catch(() => { topPages.value = [] })
    .finally(() => { topPagesLoading.value = false })

  // ── top 10 queries (by clicks, in current window) ───────────────────
  topKeywordsLoading.value = true
  query<TopKeywordRow>({
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
      LIMIT 10
    `,
  })
    .then((rows) => {
      topKeywords.value = rows.map(r => ({ query: String(r.query), clicks: Number(r.clicks), impressions: Number(r.impressions), sum_position: Number(r.sum_position) }))
    })
    .catch(() => { topKeywords.value = [] })
    .finally(() => { topKeywordsLoading.value = false })
}

watch([siteId, () => ranges.value.current.start, () => ranges.value.current.end, () => ranges.value.previous?.start, () => ranges.value.previous?.end, ready], refresh, { immediate: true })

// ── formatting + diff helpers ─────────────────────────────────────────
function fmtInt(n: number | null | undefined): string {
  return n == null ? '–' : new Intl.NumberFormat().format(Math.round(n))
}
function fmtPct(n: number | null | undefined): string {
  return n == null ? '–' : `${(n * 100).toFixed(2)}%`
}
function fmtPos(n: number | null | undefined): string {
  return n == null || n <= 0 ? '–' : n.toFixed(1)
}
function fmtGrowth(g: number | null, invert = false): string {
  if (g == null)
    return ''
  const v = invert ? -g : g
  const sign = v > 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(1)}%`
}
function growthColor(g: number | null, invert = false): 'success' | 'error' | 'neutral' {
  if (g == null || Math.abs(g) < 0.005)
    return 'neutral'
  const v = invert ? -g : g
  return v > 0 ? 'success' : 'error'
}

const currentSummary = computed(() => {
  if (!currentTotals.value)
    return null
  const t = currentTotals.value
  const impressions = Number(t.impressions) || 0
  const clicks = Number(t.clicks) || 0
  const sumPosition = Number(t.sum_position) || 0
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    // GSC `sum_position` is the sum of position values; mean position is
    // sum_position / impressions + 1 (zero-indexed in the API).
    position: impressions > 0 ? sumPosition / impressions + 1 : 0,
  }
})

const previousSummary = computed(() => {
  if (!previousTotals.value)
    return null
  const t = previousTotals.value
  const impressions = Number(t.impressions) || 0
  const clicks = Number(t.clicks) || 0
  const sumPosition = Number(t.sum_position) || 0
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? sumPosition / impressions + 1 : 0,
  }
})

function growthFor(curr: number, prev: number | null | undefined): number | null {
  return computeGrowth(curr, prev)
}

const kpis = computed(() => {
  if (!currentSummary.value)
    return []
  const c = currentSummary.value
  const p = previousSummary.value
  return [
    { title: 'Clicks', icon: 'i-lucide-mouse-pointer-click', value: fmtInt(c.clicks), trend: p ? growthFor(c.clicks, p.clicks) : null },
    { title: 'Impressions', icon: 'i-lucide-eye', value: fmtInt(c.impressions), trend: p ? growthFor(c.impressions, p.impressions) : null },
    { title: 'CTR', icon: 'i-lucide-percent', value: fmtPct(c.ctr), trend: p ? growthFor(c.ctr, p.ctr) : null },
    { title: 'Avg. position', icon: 'i-lucide-hash', value: fmtPos(c.position), trend: p ? growthFor(c.position, p.position) : null, invertTrend: true },
  ]
})

const topPageRows = computed(() => (topPages.value ?? []).map(r => ({
  label: r.url,
  metric: r.clicks,
  secondary: `${r.impressions.toLocaleString()} impr`,
})))

const topKeywordRows = computed(() => (topKeywords.value ?? []).map(r => ({
  label: r.query,
  metric: r.clicks,
  secondary: `${r.impressions.toLocaleString()} impr`,
})))

// Surface the per-table stage in a tiny inline hint while the analyzer warms up.
const datesStage = computed(() => tables.value.dates.stage)
const queriesStage = computed(() => tables.value.queries.stage)
const pagesStage = computed(() => tables.value.pages.stage)
const currentHostname = computed(() => currentSite.value?.hostname && currentSite.value.hostname.includes('.') ? currentSite.value.hostname : null)
</script>

<template>
  <GscDashboardPage gap="lg">
    <template #header>
      <GscPageHeader
        :crumbs="[
          { label: 'Overview', to: '/' },
          { label: 'Sites' },
        ]"
        :title="currentHostname ?? siteId"
        icon="i-lucide-globe"
        description="Search performance across the selected period."
      >
        <template #icon>
          <GscFavicon v-if="currentHostname" :domain="currentHostname" :size="18" :alt="currentHostname" />
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

    <UAlert
      v-if="analyzerError"
      color="error"
      icon="i-lucide-alert-circle"
      :title="`Analyzer error: ${analyzerError.message}`"
    />

    <!-- KPI cards with Δ% vs previous period. Cards render the moment the
         `dates` table finishes attach; the chart fills in shortly after. -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div
        v-for="kpi in (kpis.length ? kpis : [{ title: 'Clicks' }, { title: 'Impressions' }, { title: 'CTR' }, { title: 'Avg. position' }])"
        :key="kpi.title"
        class="rounded-lg border border-default bg-default p-4"
      >
        <div class="flex items-center justify-between gap-2 mb-1">
          <span class="text-[11px] uppercase tracking-widest text-dimmed">{{ kpi.title }}</span>
          <UIcon v-if="(kpi as any).icon" :name="(kpi as any).icon" class="size-3.5 text-dimmed" />
        </div>
        <div class="flex items-baseline gap-2">
          <span class="text-xl font-semibold tabular-nums text-default">
            <template v-if="(kpi as any).value">{{ (kpi as any).value }}</template>
            <span v-else class="inline-block w-16 h-5 rounded bg-muted/40 animate-pulse" />
          </span>
          <UBadge
            v-if="(kpi as any).trend != null"
            :color="growthColor((kpi as any).trend, (kpi as any).invertTrend)"
            variant="soft"
            size="xs"
            class="tabular-nums"
          >
            {{ fmtGrowth((kpi as any).trend, (kpi as any).invertTrend) }}
          </UBadge>
        </div>
      </div>
    </div>

    <!-- Performance chart: daily clicks/impressions over the current window. -->
    <div class="rounded-lg border border-default bg-default p-4">
      <div class="flex items-center justify-between mb-3">
        <div>
          <h2 class="text-sm font-semibold text-default">
            Performance
          </h2>
          <p class="text-[11px] text-dimmed">
            Daily totals from the <code class="text-[11px]">dates</code> Iceberg table.
          </p>
        </div>
        <span v-if="datesStage !== 'ready'" class="text-[11px] text-dimmed inline-flex items-center gap-1.5">
          <UIcon name="i-lucide-loader" class="size-3 animate-spin" />
          {{ datesStage === 'downloading' ? `Downloading ${tables.dates.filesAttached}/${tables.dates.filesTotal}` : datesStage }}
        </span>
      </div>
      <ClientOnly>
        <GscHero
          v-if="dailyPayload"
          :payload="dailyPayload"
          :range="range"
          :compare-mode="compareMode"
        />
      </ClientOnly>
      <div v-if="!dailyPayload" class="h-40 rounded bg-muted/20 animate-pulse" />
    </div>

    <!-- Top lists: queries + pages. Each waits on its own table attach so the
         user sees the chart populate first, then the lists fill in. -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <GscDataList
          title="Top queries"
          :description="`Top 10 by clicks · ${range.start} → ${range.end}`"
          :rows="topKeywordRows"
          :empty="queriesStage === 'unavailable' ? 'No data in range.' : queriesStage === 'ready' ? 'No queries yet.' : null"
        />
        <div v-if="!topKeywords && queriesStage !== 'unavailable'" class="space-y-2 mt-1">
          <div v-for="i in 5" :key="i" class="h-6 rounded bg-muted/30 animate-pulse" />
        </div>
      </div>
      <div>
        <GscDataList
          title="Top pages"
          :description="`Top 10 by clicks · ${range.start} → ${range.end}`"
          :rows="topPageRows"
          :empty="pagesStage === 'unavailable' ? 'No data in range.' : pagesStage === 'ready' ? 'No pages yet.' : null"
        />
        <div v-if="!topPages && pagesStage !== 'unavailable'" class="space-y-2 mt-1">
          <div v-for="i in 5" :key="i" class="h-6 rounded bg-muted/30 animate-pulse" />
        </div>
      </div>
    </div>
  </GscDashboardPage>
</template>
