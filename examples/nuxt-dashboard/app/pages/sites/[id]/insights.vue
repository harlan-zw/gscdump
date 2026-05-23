<script setup lang="ts">
// Curated Insights grid: 6 analyzers presented as small cards with a
// headline number + summary line + "View full" link back to /analyze.
// Each card runs its analyzer in parallel and pulls the single
// most-important number out of the result.

definePageMeta({ key: route => `site-insights:${route.params.id}` })

const { siteId } = useGscCurrentSite()

const { period, compareMode, stableData, range } = useGscPeriod()

const { analyze, ready: isReady, error: bootError } = useGscSiteAnalyzer(siteId, range)

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
  accent: GscAnalyzerAccent
}

// Pulled from the registry — analyzers that opted in via `capabilities.insightCard`.
const DEFS = useGscAnalyzerDefsWithCapability('insightCard')

// Pool of 2 lets the cheap analyzers (striking-distance, movers) render
// promptly while the heavier ones (cannibalization, ctr-anomaly) catch up
// behind them. DuckDB-WASM is single-threaded so higher parallelism just
// serializes behind one connection.
const { states, run } = useGscAnalyzerBatch<{ results: unknown[], meta: Record<string, unknown> }>(
  { analyze: params => analyze(params as never) },
  DEFS.map(d => d.id),
  range,
  { concurrency: 2, filter: id => supports(id).value },
)

const cards = computed<Record<string, InsightCard>>(() => {
  const out: Record<string, InsightCard> = {}
  for (const def of DEFS) {
    const entry = states.value[def.id]
    if (!entry || entry.status === 'pending' || entry.status === 'running' || entry.status === 'skipped' || entry.status === 'idle')
      continue
    const card = def.capabilities.insightCard
    if (entry.status === 'done' && entry.result) {
      const { headline, tagline } = card.summarize(entry.result)
      out[def.id] = {
        id: def.id,
        label: def.label,
        description: card.description,
        icon: card.icon,
        accent: card.accent,
        headline,
        tagline,
      }
    }
    else {
      out[def.id] = {
        id: def.id,
        label: def.label,
        description: card.description,
        icon: card.icon,
        accent: 'neutral',
        headline: '—',
        tagline: 'unavailable',
      }
    }
  }
  return out
})

const running = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {}
  for (const def of DEFS)
    out[def.id] = states.value[def.id]?.status === 'running'
  return out
})

watch([isReady, period, stableData], () => {
  if (isReady.value)
    run()
}, { immediate: true })

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
      <GscSitePageHeader
        :tail="[{ label: 'Insights' }]"
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
      </GscSitePageHeader>
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
        :icon="def.capabilities.insightCard.icon"
        :title="def.label"
        :description="def.capabilities.insightCard.description"
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
          {{ cards[def.id]?.tagline ?? def.capabilities.insightCard.description.split('.')[0] }}
        </template>
      </GscLockedCard>
    </div>
  </GscDashboardPage>
</template>
