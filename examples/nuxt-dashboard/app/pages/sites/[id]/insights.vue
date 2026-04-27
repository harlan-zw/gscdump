<script setup lang="ts">
// Curated Insights grid: 6 analyzers presented as small cards with a
// headline number + summary line + "View full" link back to /analyze.
// Each card runs its analyzer in parallel and pulls the single
// most-important number out of the result.

definePageMeta({ key: route => `site-insights:${route.params.id}` })

const route = useRoute()
const siteId = computed(() => String(route.params.id))
const currentSite = useGscSite(siteId)

type Period = typeof PERIOD_PRESETS[number]['value']
const period = ref<Period>('28d')
const stableData = ref(true)
const compareMode = ref<'previous' | 'year' | 'none'>('none')
const range = computed(() => periodToDateRange(period.value, stableData.value))

const { analyze, ready: isReady, error: bootError } = useGscAnalyzer(siteId)

// Which analyzer ids the server-resolved source can actually run. Cards
// outside this set render as locked instead of firing 402 for every load.
const { supports } = useGscAnalyticsSourceInfo(siteId)

interface InsightCard {
  id: string
  label: string
  description: string
  headline: string
  tagline: string
  icon: string
  accent: 'primary' | 'warning' | 'success' | 'error' | 'neutral'
}

const cards = ref<Record<string, InsightCard>>({})
const running = ref<Record<string, boolean>>({})

function nfmt(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n))
}

interface Definition {
  id: string
  label: string
  description: string
  icon: string
  accent: InsightCard['accent']
  summarize: (res: { results: unknown[], meta: Record<string, unknown> }) => { headline: string, tagline: string }
}

const DEFS: Definition[] = [
  {
    id: 'striking-distance',
    label: 'Striking distance',
    description: 'Queries ranking positions 5–20 — one push away from the first page.',
    icon: 'i-lucide-target',
    accent: 'primary',
    summarize: (res) => {
      const n = res.results.length
      return {
        headline: `${nfmt(n)}`,
        tagline: `queries ranked 5–20 with upside`,
      }
    },
  },
  {
    id: 'opportunity',
    label: 'Opportunity',
    description: 'High-impression / low-CTR pages where a title rewrite pays back fast.',
    icon: 'i-lucide-zap',
    accent: 'warning',
    summarize: (res) => {
      const n = res.results.length
      return {
        headline: `${nfmt(n)}`,
        tagline: `underperforming pages flagged`,
      }
    },
  },
  {
    id: 'cannibalization',
    label: 'Cannibalization',
    description: 'Queries where multiple URLs of yours compete for the same SERP.',
    icon: 'i-lucide-git-fork',
    accent: 'error',
    summarize: (res) => {
      const stolen = typeof res.meta.totalStolenClicks === 'number' ? res.meta.totalStolenClicks : 0
      return {
        headline: `${nfmt(stolen)}`,
        tagline: `clicks lost to competing URLs`,
      }
    },
  },
  {
    id: 'movers',
    label: 'Movers',
    description: 'Biggest WoW gainers + losers ranked by impression-weighted delta.',
    icon: 'i-lucide-trending-up',
    accent: 'success',
    summarize: (res) => {
      const n = res.results.length
      return {
        headline: `${nfmt(n)}`,
        tagline: `queries with significant movement`,
      }
    },
  },
  {
    id: 'ctr-anomaly',
    label: 'CTR anomalies',
    description: 'Pages whose CTR collapsed while position held — likely SERP feature theft.',
    icon: 'i-lucide-alert-octagon',
    accent: 'warning',
    summarize: (res) => {
      const lost = typeof res.meta.totalClicksLost === 'number' ? res.meta.totalClicksLost : 0
      return {
        headline: `${nfmt(lost)}`,
        tagline: `clicks lost to CTR dips`,
      }
    },
  },
  {
    id: 'long-tail',
    label: 'Long-tail',
    description: 'Pages with healthy tail distribution vs. head-heavy risk concentration.',
    icon: 'i-lucide-bar-chart-3',
    accent: 'neutral',
    summarize: (res) => {
      const fp = (res.meta.fingerprints as Record<string, number> | undefined) ?? {}
      const flat = fp['flat-tail'] ?? 0
      return {
        headline: `${nfmt(flat)}`,
        tagline: `pages with a flat, durable tail`,
      }
    },
  },
]

async function runOne(def: Definition) {
  running.value[def.id] = true
  try {
    const res = await analyze({
      type: def.id,
      dateStart: range.value.start,
      dateEnd: range.value.end,
    } as never)
    const { headline, tagline } = def.summarize(res as { results: unknown[], meta: Record<string, unknown> })
    cards.value[def.id] = {
      id: def.id,
      label: def.label,
      description: def.description,
      icon: def.icon,
      accent: def.accent,
      headline,
      tagline,
    }
  }
  catch {
    cards.value[def.id] = {
      id: def.id,
      label: def.label,
      description: def.description,
      icon: def.icon,
      accent: 'neutral',
      headline: '—',
      tagline: 'unavailable',
    }
  }
  finally {
    running.value[def.id] = false
  }
}

// Limit concurrent analyzer runs. DuckDB-WASM is single-threaded — firing six
// analyzers in parallel just serializes them behind the same connection and
// delays first paint of the faster cards. A pool of 2 lets the cheap cards
// (striking-distance, movers) render promptly while the heavier ones
// (cannibalization, ctr-anomaly) catch up behind them.
const CONCURRENCY = 2

async function runAll() {
  if (!isReady.value)
    return
  // Skip analyzers the current source can't run — they'd 402 and spam the
  // console. The template renders a locked card for the skipped ones.
  const queue = DEFS.filter(d => supports(d.id).value)
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const def = queue.shift()
      if (!def)
        break
      await runOne(def)
    }
  })
  await Promise.all(workers)
}

watch([isReady, period, stableData], runAll, { immediate: true })

function accentClasses(a: InsightCard['accent']): string {
  switch (a) {
    case 'primary': return 'text-primary'
    case 'success': return 'text-success'
    case 'warning': return 'text-warning'
    case 'error': return 'text-error'
    default: return 'text-default'
  }
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscPageHeader
        :crumbs="[
          { label: 'Overview', to: '/' },
          { label: currentSite?.hostname ?? siteId, to: `/sites/${encodeURIComponent(siteId)}` },
          { label: 'Insights' },
        ]"
        title="Insights"
        icon="i-lucide-sparkles"
        description="Curated analyzer digest — one headline per insight. Open Analyze for the full result."
      >
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
      v-if="bootError"
      color="error"
      icon="i-lucide-alert-circle"
      title="Failed to boot DuckDB-WASM"
      :description="bootError.message"
    />

    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      <GscLockedCard
        v-for="def in DEFS"
        :key="def.id"
        :locked="!supports(def.id).value"
        :icon="def.icon"
        :title="def.label"
        :description="def.description"
        :cta-href="`/sites/${encodeURIComponent(siteId)}/analyze`"
        :headline-class="accentClasses(cards[def.id]?.accent ?? 'neutral')"
        locked-tagline="Requires the stored parquet dataset (Pro)."
      >
        <template #headline>
          <template v-if="running[def.id] && !cards[def.id]">
            …
          </template>
          <template v-else>
            {{ cards[def.id]?.headline ?? '—' }}
          </template>
        </template>
        <template #tagline>
          {{ cards[def.id]?.tagline ?? def.description.split('.')[0] }}
        </template>
      </GscLockedCard>
    </div>
  </GscDashboardPage>
</template>
