<script setup lang="ts">
// Search appearance tab: per-facet breakdown (AMP, rich results, videos, etc.).
// Sourced from the shared per-site DuckDB-WASM analyzer over the
// `search_appearance` Iceberg fact table.

definePageMeta({ key: route => `site-search-appearance:${route.params.id}` })

interface SearchAppearanceRow {
  searchAppearance: string
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

const rows = ref<SearchAppearanceRow[]>([])
const previousRows = ref<SearchAppearanceRow[]>([])

async function refresh() {
  if (!siteId.value)
    return
  const r = ranges.value

  query<SearchAppearanceRow>({
    needs: ['search_appearance'],
    sql: `
      SELECT
        searchAppearance,
        SUM(clicks)::DOUBLE AS clicks,
        SUM(impressions)::DOUBLE AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM search_appearance
      WHERE date >= DATE '${r.current.start}' AND date <= DATE '${r.current.end}'
      GROUP BY searchAppearance
      ORDER BY clicks DESC
    `,
  })
    .then((res) => {
      rows.value = res.map(row => ({
        searchAppearance: String(row.searchAppearance ?? ''),
        clicks: Number(row.clicks) || 0,
        impressions: Number(row.impressions) || 0,
        sum_position: Number(row.sum_position) || 0,
      }))
    })
    .catch(() => { rows.value = [] })

  if (r.previous) {
    query<SearchAppearanceRow>({
      needs: ['search_appearance'],
      sql: `
        SELECT
          searchAppearance,
          SUM(clicks)::DOUBLE AS clicks,
          SUM(impressions)::DOUBLE AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM search_appearance
        WHERE date >= DATE '${r.previous.start}' AND date <= DATE '${r.previous.end}'
        GROUP BY searchAppearance
      `,
    })
      .then((res) => {
        previousRows.value = res.map(row => ({
          searchAppearance: String(row.searchAppearance ?? ''),
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

const saStage = computed(() => tables.value.search_appearance.stage)
const isLoading = computed(() => saStage.value !== 'ready' && saStage.value !== 'unavailable')

const previousByKey = computed(() => {
  const map = new Map<string, SearchAppearanceRow>()
  for (const r of previousRows.value)
    map.set(r.searchAppearance, r)
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
        :tail="[{ label: 'Search appearance' }]"
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
            <td v-if="hasCompare" class="px-4 py-2.5 text-right">
              <UBadge
                v-if="growthFor(r.clicks, previousByKey.get(r.searchAppearance)?.clicks) != null"
                :color="growthColor(growthFor(r.clicks, previousByKey.get(r.searchAppearance)?.clicks))"
                variant="soft"
                size="xs"
                class="tabular-nums"
              >
                {{ fmtGrowth(growthFor(r.clicks, previousByKey.get(r.searchAppearance)?.clicks)) }}
              </UBadge>
              <span v-else class="text-[11px] text-dimmed">–</span>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ r.impressions.toLocaleString() }}
            </td>
            <td v-if="hasCompare" class="px-4 py-2.5 text-right">
              <UBadge
                v-if="growthFor(r.impressions, previousByKey.get(r.searchAppearance)?.impressions) != null"
                :color="growthColor(growthFor(r.impressions, previousByKey.get(r.searchAppearance)?.impressions))"
                variant="soft"
                size="xs"
                class="tabular-nums"
              >
                {{ fmtGrowth(growthFor(r.impressions, previousByKey.get(r.searchAppearance)?.impressions)) }}
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
