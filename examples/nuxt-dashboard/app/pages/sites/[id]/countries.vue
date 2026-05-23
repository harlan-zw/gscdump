<script setup lang="ts">
// Countries tab: per-country breakdown sourced from the shared per-site
// DuckDB-WASM analyzer. The `countries` Iceberg fact table is attached
// lazily; sibling tabs that already touched it (or had it preloaded by the
// overview) make this render basically instant.

definePageMeta({ key: route => `site-countries:${route.params.id}` })

interface CountryRow {
  country: string
  clicks: number
  impressions: number
  sum_position: number
}

const { siteId } = useGscCurrentSite()
const { period, compareMode, stableData, range } = useGscPeriod()

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

const rows = ref<CountryRow[]>([])
const previousRows = ref<CountryRow[]>([])

async function refresh() {
  if (!siteId.value)
    return
  const r = ranges.value

  query<CountryRow>({
    needs: ['countries'],
    sql: `
      SELECT
        country,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM countries
      WHERE date >= DATE '${r.current.start}' AND date <= DATE '${r.current.end}'
      GROUP BY country
      ORDER BY clicks DESC
    `,
  })
    .then((res) => {
      rows.value = res.map(row => ({
        country: String(row.country),
        clicks: Number(row.clicks) || 0,
        impressions: Number(row.impressions) || 0,
        sum_position: Number(row.sum_position) || 0,
      }))
    })
    .catch(() => { rows.value = [] })

  if (r.previous) {
    query<CountryRow>({
      needs: ['countries'],
      sql: `
        SELECT
          country,
          SUM(clicks)::DOUBLE AS clicks,
          SUM(impressions)::DOUBLE AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM countries
        WHERE date >= DATE '${r.previous.start}' AND date <= DATE '${r.previous.end}'
        GROUP BY country
      `,
    })
      .then((res) => {
        previousRows.value = res.map(row => ({
          country: String(row.country),
          clicks: Number(row.clicks) || 0,
          impressions: Number(row.impressions) || 0,
          sum_position: Number(row.sum_position) || 0,
        }))
      })
      .catch(() => { previousRows.value = [] })
  }
  else {
    previousRows.value = []
  }
}

watch(
  [siteId, () => ranges.value.current.start, () => ranges.value.current.end, () => ranges.value.previous?.start, () => ranges.value.previous?.end],
  refresh,
  { immediate: true },
)

const countriesStage = computed(() => tables.value.countries.stage)
const isLoading = computed(() => countriesStage.value !== 'ready' && countriesStage.value !== 'unavailable')

const previousByCountry = computed(() => {
  const map = new Map<string, CountryRow>()
  for (const r of previousRows.value)
    map.set(r.country, r)
  return map
})

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

function displayName(code: string): string {
  if (code.length === 3)
    return countryName(code.toUpperCase()) || code.toUpperCase()
  return countryName(code.toUpperCase()) || code
}

function flagEmoji(code: string): string {
  if (code.length !== 2)
    return '🌐'
  const upper = code.toUpperCase()
  const codePoints = [...upper].map(c => 127397 + c.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}

function growthFor(curr: number, prev: number | null | undefined): number | null {
  return computeGrowth(curr, prev)
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

const hasCompare = computed(() => ranges.value.previous != null)
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Countries' }]"
        title="Countries"
        icon="i-lucide-globe"
        description="Search performance by searcher country."
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

    <div
      v-if="!isLoading && !rows.length"
      class="rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted"
    >
      No country data in the selected period.
    </div>

    <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <tr>
            <th class="px-4 py-2.5 text-left">
              Country
            </th>
            <th class="px-4 py-2.5 text-left">
              Share
            </th>
            <th class="px-4 py-2.5 text-right w-[110px]">
              Clicks
            </th>
            <th v-if="hasCompare" class="px-4 py-2.5 text-right w-[80px]">
              Δ Clicks
            </th>
            <th class="px-4 py-2.5 text-right w-[130px]">
              Impressions
            </th>
            <th v-if="hasCompare" class="px-4 py-2.5 text-right w-[80px]">
              Δ Impr
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
          <template v-if="isLoading && !rows.length">
            <tr v-for="i in 8" :key="`skel-${i}`">
              <td class="px-4 py-2.5">
                <div class="h-4 rounded bg-muted/30 animate-pulse w-48" />
              </td>
              <td class="px-4 py-2.5">
                <div class="h-1.5 rounded-full bg-muted/30 animate-pulse" />
              </td>
              <td class="px-4 py-2.5">
                <div class="h-4 rounded bg-muted/30 animate-pulse ml-auto w-16" />
              </td>
              <td v-if="hasCompare" class="px-4 py-2.5">
                <div class="h-4 rounded bg-muted/30 animate-pulse ml-auto w-12" />
              </td>
              <td class="px-4 py-2.5">
                <div class="h-4 rounded bg-muted/30 animate-pulse ml-auto w-20" />
              </td>
              <td v-if="hasCompare" class="px-4 py-2.5">
                <div class="h-4 rounded bg-muted/30 animate-pulse ml-auto w-12" />
              </td>
              <td class="px-4 py-2.5">
                <div class="h-4 rounded bg-muted/30 animate-pulse ml-auto w-10" />
              </td>
              <td class="px-4 py-2.5">
                <div class="h-4 rounded bg-muted/30 animate-pulse ml-auto w-10" />
              </td>
            </tr>
          </template>
          <tr
            v-for="(r, i) in rows"
            v-else
            :key="r.country"
            class="hover:bg-elevated/30 transition-colors"
          >
            <td class="px-4 py-2.5 max-w-[280px]">
              <div class="flex items-center gap-2">
                <span class="text-[11px] tabular-nums text-dimmed w-5 text-right shrink-0">
                  {{ i + 1 }}
                </span>
                <span class="text-base shrink-0">{{ flagEmoji(r.country) }}</span>
                <span class="truncate text-default" :title="r.country">{{ displayName(r.country) }}</span>
                <span class="text-[11px] text-dimmed font-mono shrink-0">{{ r.country.toUpperCase() }}</span>
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
            <td v-if="hasCompare" class="px-4 py-2.5 text-right">
              <UBadge
                v-if="growthFor(r.clicks, previousByCountry.get(r.country)?.clicks) != null"
                :color="growthColor(growthFor(r.clicks, previousByCountry.get(r.country)?.clicks))"
                variant="soft"
                size="xs"
                class="tabular-nums"
              >
                {{ fmtGrowth(growthFor(r.clicks, previousByCountry.get(r.country)?.clicks)) }}
              </UBadge>
              <span v-else class="text-[11px] text-dimmed">–</span>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ r.impressions.toLocaleString() }}
            </td>
            <td v-if="hasCompare" class="px-4 py-2.5 text-right">
              <UBadge
                v-if="growthFor(r.impressions, previousByCountry.get(r.country)?.impressions) != null"
                :color="growthColor(growthFor(r.impressions, previousByCountry.get(r.country)?.impressions))"
                variant="soft"
                size="xs"
                class="tabular-nums"
              >
                {{ fmtGrowth(growthFor(r.impressions, previousByCountry.get(r.country)?.impressions)) }}
              </UBadge>
              <span v-else class="text-[11px] text-dimmed">–</span>
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
