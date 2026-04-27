<script setup lang="ts">
// Multi-site overview. Lists every site visible to the current identity and
// fans out `daily_totals` rollup fetches to render per-site stats. The period
// selector drives which slice of the rollup's day-array we aggregate; growth
// is computed against the preceding equal-length window (or YoY).

type Period = typeof PERIOD_PRESETS[number]['value']
type CompareMode = typeof COMPARE_OPTIONS[number]['value']

interface DailyTotal {
  // Rollup writer stamps this as Unix ms (see rollups.ts) — not an ISO date.
  date: number
  clicks: number
  impressions: number
  sum_position: number
  anonymizedImpressionsPct: number
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

interface WindowTotals {
  clicks: number
  impressions: number
  ctr: number
  position: number
  sparkline: number[]
}

interface SiteStats {
  current: WindowTotals
  previous: WindowTotals | null
  builtAt: number | null
}

const period = ref<Period>('28d')
const compareMode = ref<CompareMode>('previous')
const stableData = ref(true)
const { sites, loading: sitesLoading, error: sitesError } = useGscSites()

// Free-tier fanout hits the live GSC API once per site — 20 sites = 20 calls
// per period change. Cap initial fetches at EAGER_CAP; extra rows render
// with no stats + a "Load" CTA that expands the cap.
const EAGER_CAP = 12
const sitesCap = ref(EAGER_CAP)
const fanoutSites = computed(() => (sites.value ?? []).slice(0, sitesCap.value))
const pendingLazyCount = computed(() => Math.max(0, (sites.value?.length ?? 0) - sitesCap.value))

const range = computed(() => periodToDateRange(period.value, stableData.value))

// Widen the server-side fetch to cover whichever comparison window is active
// — previous-period needs prevStart, YoY needs yearStart. Free-tier rollups
// then honor this range and return real data for pickers beyond 90d.
const fetchRange = computed(() => {
  const r = range.value
  const start = compareMode.value === 'year'
    ? r.yearStart
    : compareMode.value === 'previous' ? r.prevStart : r.start
  return { start, end: r.end }
})

// Fan-out fetch of daily_totals rollups. Progress for each site lands on
// the shared progress map, which <GscBootProgress> renders. The composable
// also exposes a coarse `{ completed, total }` for a count-based hint —
// useful in free tier where each site is a live GSC API call.
const { envelopes, progress: fanoutProgress } = useGscRollupFanout<DailyTotal[]>(
  fanoutSites,
  'daily_totals',
  { range: fetchRange },
)

// Snap the requested window's `end` to the site's actual most-recent data
// point. Without this, a syncing site whose last day is earlier than
// (today - stable-latency) compares a short-current window to a full-length
// previous window and shows a false decline.
function snapWindowToData(payload: DailyTotal[], start: string, end: string): { start: string, end: string } {
  let maxIso: string | null = null
  for (const d of payload) {
    const iso = toIso(d.date)
    if (!maxIso || iso > maxIso)
      maxIso = iso
  }
  if (!maxIso || maxIso >= end)
    return { start, end }
  // Keep window length constant by shifting both ends.
  const shift = daysBetween(end, maxIso)
  return { start: shiftIso(start, shift), end: maxIso }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
}
function shiftIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10)
}

const stats = computed<Record<string, SiteStats | null>>(() => {
  const out: Record<string, SiteStats | null> = {}
  for (const [id, env] of Object.entries(envelopes.value)) {
    if (!env?.payload?.length) {
      out[id] = null
      continue
    }
    const { start, end, prevStart, prevEnd, yearStart, yearEnd } = range.value
    const snapped = snapWindowToData(env.payload, start, end)
    const shift = daysBetween(end, snapped.end)
    const cmpRawStart = compareMode.value === 'year' ? yearStart : prevStart
    const cmpRawEnd = compareMode.value === 'year' ? yearEnd : prevEnd
    const cmpStart = shift ? shiftIso(cmpRawStart, shift) : cmpRawStart
    const cmpEnd = shift ? shiftIso(cmpRawEnd, shift) : cmpRawEnd
    out[id] = {
      current: summarize(env.payload, snapped.start, snapped.end),
      previous: compareMode.value === 'none' ? null : summarize(env.payload, cmpStart, cmpEnd),
      builtAt: env.builtAt,
    }
  }
  return out
})

function summarize(days: DailyTotal[], start: string, end: string): WindowTotals {
  let clicks = 0
  let impressions = 0
  let weightedPosition = 0
  const sparkline: number[] = []
  for (const d of days) {
    const iso = toIso(d.date)
    if (iso < start || iso > end)
      continue
    clicks += d.clicks
    impressions += d.impressions
    weightedPosition += d.sum_position
    sparkline.push(d.clicks)
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions + 1 : 0,
    sparkline,
  }
}

const totals = computed(() => {
  let clicks = 0
  let impressions = 0
  let weightedPosition = 0
  let prevClicks = 0
  let prevImpressions = 0
  let prevWeightedPosition = 0
  let havePrev = false
  for (const s of Object.values(stats.value)) {
    if (!s)
      continue
    clicks += s.current.clicks
    impressions += s.current.impressions
    weightedPosition += s.current.position * s.current.impressions
    if (s.previous) {
      havePrev = true
      prevClicks += s.previous.clicks
      prevImpressions += s.previous.impressions
      prevWeightedPosition += s.previous.position * s.previous.impressions
    }
  }
  const current = {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions : 0,
  }
  const previous = havePrev
    ? {
        clicks: prevClicks,
        impressions: prevImpressions,
        ctr: prevImpressions > 0 ? prevClicks / prevImpressions : 0,
        position: prevImpressions > 0 ? prevWeightedPosition / prevImpressions : 0,
      }
    : null
  return { current, previous }
})

function fmtInt(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n))
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}
function fmtPos(n: number): string {
  return n > 0 ? n.toFixed(1) : '–'
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

function growthFor(curr: number, prev: number | null | undefined): number | null {
  return computeGrowth(curr, prev)
}
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <header class="max-w-[1128px] px-4 sm:px-6 lg:px-9 border-b border-default pb-3">
      <div class="flex items-start gap-4 pt-5">
        <div class="flex flex-col sm:flex-row justify-between min-w-0 w-full gap-3 sm:gap-0">
          <div class="min-w-0">
            <h1 class="text-xl font-semibold tracking-tight text-default">
              Overview
            </h1>
            <p class="text-[13px] text-muted mt-0.5 leading-snug">
              Aggregated search performance across all sites.
            </p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <GscDateRangePicker
              v-model:period="period"
              v-model:compare-mode="compareMode"
              v-model:stable-data="stableData"
            />
          </div>
        </div>
      </div>
    </header>

    <div class="max-w-[1128px] px-4 sm:px-6 lg:px-9 pt-5 pb-10 flex flex-col gap-5 flex-1 w-full">
      <GscBootProgress />

      <div
        v-if="fanoutProgress.total > 0 && fanoutProgress.completed < fanoutProgress.total"
        class="flex items-center gap-2 text-[11px] text-dimmed"
      >
        <UIcon name="i-lucide-loader" class="size-3 animate-spin" />
        <span class="tabular-nums">
          Loaded {{ fanoutProgress.completed }} of {{ fanoutProgress.total }} sites…
        </span>
      </div>

      <UiWidgetState
        :status="sitesLoading ? 'pending' : sitesError ? 'error' : 'success'"
        :error="sitesError"
        :empty="!sites?.length"
        :skeleton-lines="3"
        empty-icon="i-lucide-database"
        empty-title="No sites found"
        empty-message="Run `gscdump sync` to populate data."
      >
        <!-- Aggregate stats -->
        <UiStats
          variant="cards"
          layout="grid"
          :data="[
            { title: 'Clicks',
              icon: 'i-lucide-mouse-pointer-click',
              value: fmtInt(totals.current.clicks),
              trend: totals.previous ? growthFor(totals.current.clicks, totals.previous.clicks) ?? null : null,
              trendSuffix: '%' },
            { title: 'Impressions',
              icon: 'i-lucide-eye',
              value: fmtInt(totals.current.impressions),
              trend: totals.previous ? growthFor(totals.current.impressions, totals.previous.impressions) ?? null : null,
              trendSuffix: '%' },
            { title: 'CTR',
              icon: 'i-lucide-percent',
              value: fmtPct(totals.current.ctr),
              trend: totals.previous ? growthFor(totals.current.ctr, totals.previous.ctr) ?? null : null,
              trendSuffix: '%' },
            { title: 'Avg. position',
              icon: 'i-lucide-hash',
              value: fmtPos(totals.current.position),
              trend: totals.previous ? growthFor(totals.current.position, totals.previous.position) ?? null : null,
              trendSuffix: '%',
              invertTrend: true },
          ]"
        />

        <!-- Per-site table -->
        <div class="rounded-lg border border-default bg-default overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
                <tr>
                  <th class="px-4 py-2.5 text-left">
                    Site
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    Clicks
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    Δ
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    Impressions
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    Δ
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    CTR
                  </th>
                  <th class="px-4 py-2.5 text-right">
                    Position
                  </th>
                  <th class="px-4 py-2.5 text-right w-[110px]">
                    Trend
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="site in fanoutSites" :key="site.id" class="hover:bg-elevated/30 transition-colors">
                  <td class="px-4 py-3">
                    <NuxtLink
                      :to="`/sites/${encodeURIComponent(site.id)}`"
                      class="inline-flex items-center gap-2 font-medium text-default hover:text-primary"
                    >
                      <GscFavicon :domain="site.hostname" :size="16" :alt="site.hostname" />
                      <span>{{ site.hostname }}</span>
                    </NuxtLink>
                    <UBadge
                      v-if="site.propertyType === 'url-prefix'"
                      color="neutral"
                      variant="soft"
                      size="xs"
                      class="ml-2 font-normal"
                    >
                      url-prefix
                    </UBadge>
                  </td>
                  <td class="px-4 py-3 text-right tabular-nums">
                    {{ stats[site.id] ? fmtInt(stats[site.id]!.current.clicks) : '–' }}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <UBadge
                      v-if="stats[site.id]?.previous"
                      :color="growthColor(growthFor(stats[site.id]!.current.clicks, stats[site.id]!.previous!.clicks))"
                      variant="soft"
                      size="xs"
                      class="tabular-nums"
                    >
                      {{ fmtGrowth(growthFor(stats[site.id]!.current.clicks, stats[site.id]!.previous!.clicks)) }}
                    </UBadge>
                  </td>
                  <td class="px-4 py-3 text-right tabular-nums">
                    {{ stats[site.id] ? fmtInt(stats[site.id]!.current.impressions) : '–' }}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <UBadge
                      v-if="stats[site.id]?.previous"
                      :color="growthColor(growthFor(stats[site.id]!.current.impressions, stats[site.id]!.previous!.impressions))"
                      variant="soft"
                      size="xs"
                      class="tabular-nums"
                    >
                      {{ fmtGrowth(growthFor(stats[site.id]!.current.impressions, stats[site.id]!.previous!.impressions)) }}
                    </UBadge>
                  </td>
                  <td class="px-4 py-3 text-right tabular-nums">
                    {{ stats[site.id] ? fmtPct(stats[site.id]!.current.ctr) : '–' }}
                  </td>
                  <td class="px-4 py-3 text-right tabular-nums">
                    {{ stats[site.id] ? fmtPos(stats[site.id]!.current.position) : '–' }}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <ClientOnly v-if="stats[site.id]?.current.sparkline.length">
                      <UiSparkline
                        :data="stats[site.id]!.current.sparkline"
                        :width="100"
                        :height="20"
                        color="blue"
                        :stroke-width="1.2"
                        class="inline-block align-middle"
                      />
                    </ClientOnly>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div
            v-if="pendingLazyCount > 0"
            class="border-t border-default px-4 py-3 flex items-center justify-between gap-3 text-[12px] text-dimmed"
          >
            <span>
              {{ pendingLazyCount }} more site{{ pendingLazyCount === 1 ? '' : 's' }} hidden — not fetched to avoid GSC API quota burn.
            </span>
            <UButton
              size="xs"
              variant="soft"
              color="neutral"
              icon="i-lucide-chevrons-down"
              @click="sitesCap = sites?.length ?? sitesCap"
            >
              Load remaining
            </UButton>
          </div>
        </div>
      </UiWidgetState>
    </div>
  </div>
</template>
