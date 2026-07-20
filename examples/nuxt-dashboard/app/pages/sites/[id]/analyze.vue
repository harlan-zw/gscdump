<script setup lang="ts">
// `/analyze` is the registry-driven analyzer playground. Raw Pages/Queries
// tables live on their dedicated subpages; this page only dispatches analyzer
// definitions from `gscAnalyzers.ts`.
//
// Adding a new analyzer = one-file change in `gscAnalyzers.ts`.

const analyzerDefs = useGscAnalyzerDefs()
const TABS = computed<GscAnalyzerDefinition[]>(() => analyzerDefs)

const activeId = ref<string>(TABS.value[0]?.id ?? '')
const activeTab = computed(() => TABS.value.find(t => t.id === activeId.value) ?? TABS.value[0] ?? null)

const { siteId } = useGscCurrentSite()

definePageMeta({ key: route => `site:${route.params.id}` })

const { period, compareMode, stableData, range: dateRange } = useGscPeriod()

const { runQuery, analyze, ready: isReady, error: bootError } = useGscAnalyzerQuery(siteId, dateRange)
const { info: sourceInfo, supports } = useGscAnalyticsSourceInfo(siteId)
const canExecuteAnalyzer = computed(() => Boolean(
  sourceInfo.value?.browserAttachEligible || sourceInfo.value?.capabilities.attachedTables,
))
const activeSupported = computed(() => {
  const tab = activeTab.value
  return tab ? supports(tab.id).value : false
})

// Provide the runner to lifecycle-owning panels. Pipeline composables such as
// `useActionPriority` hold their own state via `useState`, so panels can call
// them directly inside their setup().
provide(gscPanelRunnerKey, { runner: { query: runQuery, analyze }, ready: isReady })
const { data: dailyPayload } = useGscRollup<{ impressions: number, anonymizedImpressionsPct: number }[]>(siteId, 'daily_totals')
const anonymizationPct = computed(() => weightedAnonPct(dailyPayload.value))

const QUERY_GRAINED_TABS = computed(() => new Set<string>([
  ...analyzerDefs.filter(a => a.isQueryGrained).map(a => a.id),
]))
const showAnonymizationWarning = computed(() => QUERY_GRAINED_TABS.value.has(activeId.value))

// Analyzer-tab dispatch state. Separate from `raw` so the templates can pull
// data corresponding to the active tab without races.
const analyzerLoading = ref(false)
const analyzerError = ref<string | null>(null)
const analyzerRows = ref<unknown[]>([])
const analyzerMeta = ref<Record<string, unknown> | null>(null)
const analyzerQueryMs = ref<number | null>(null)

const activePanel = computed(() => {
  return activeTab.value?.capabilities?.panel ?? null
})

async function runActiveAnalyzer(): Promise<void> {
  const tab = activeTab.value
  if (!tab)
    return
  if (!canExecuteAnalyzer.value || !activeSupported.value) {
    analyzerLoading.value = false
    analyzerError.value = null
    analyzerRows.value = []
    analyzerMeta.value = null
    analyzerQueryMs.value = null
    return
  }
  // Pipelines run on user action via their own buttons (`ownsLifecycle: true`).
  if (activePanel.value?.ownsLifecycle)
    return

  analyzerLoading.value = true
  analyzerError.value = null
  analyzerRows.value = []
  analyzerMeta.value = null
  analyzerQueryMs.value = null
  try {
    const { start, end } = dateRange.value
    const r = await analyze({
      type: tab.id,
      startDate: start,
      endDate: end,
    } as never)
    analyzerRows.value = r.results
    analyzerMeta.value = r.meta
    analyzerQueryMs.value = r.queryMs
  }
  catch (err) {
    analyzerError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    analyzerLoading.value = false
  }
}

watch(activeId, () => {
  analyzerError.value = null
})

watch(
  [activeId, period, stableData, isReady],
  () => {
    if (!isReady.value)
      return
    void runActiveAnalyzer()
  },
)

const queryMs = computed(() => analyzerQueryMs.value)
const visibleRowCount = computed(() => analyzerRows.value.length)
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Analyze' }]"
        title="Analyzer playground"
        icon="i-lucide-flask-conical"
        description="DuckDB-WASM analytics playground — parquet attached in the browser."
      >
        <template #actions>
          <GscDateRangePicker
            v-model:period="period"
            v-model:compare-mode="compareMode"
            v-model:stable-data="stableData"
          />
          <div class="flex items-center gap-2 text-xs font-mono">
            <UBadge v-if="bootError" color="error" variant="soft" icon="i-lucide-alert-circle">
              Boot failed
            </UBadge>
            <UBadge v-else-if="!isReady" color="neutral" variant="soft" icon="i-lucide-loader">
              Booting…
            </UBadge>
            <TimingPanel
              v-else
              :timings="{ queryMs: queryMs ?? undefined }"
              source="browser"
            />
          </div>
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

    <nav class="flex items-center gap-0.5 border-b border-default -mb-px overflow-x-auto">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors"
        :class="[
          activeId === t.id
            ? 'border-primary text-default font-medium'
            : 'border-transparent text-muted hover:text-default',
          t.kind === 'analyzer' && activeId !== t.id ? 'text-muted/80' : '',
          (!isReady || analyzerLoading) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        ]"
        :disabled="!isReady || analyzerLoading"
        @click="activeId = t.id"
      >
        {{ t.label }}
      </button>
      <span v-if="queryMs != null" class="ml-auto pl-2 text-[11px] font-mono text-dimmed tabular-nums whitespace-nowrap">
        {{ Math.round(queryMs) }} ms · {{ visibleRowCount }} rows
      </span>
    </nav>

    <UAlert
      v-if="showAnonymizationWarning && anonymizationPct != null"
      color="warning"
      variant="soft"
      icon="i-lucide-alert-triangle"
      :title="`~${Math.round(anonymizationPct * 100)}% of impressions are anonymized by Google over the last 28 days`"
      description="Query-grained breakdowns sum to less than page-grained totals — GSC drops low-volume queries before you ever see them."
    />

    <UAlert
      v-if="sourceInfo && !canExecuteAnalyzer"
      color="neutral"
      variant="soft"
      icon="i-lucide-info"
      title="Analyzer execution is unavailable for this fixture source"
      description="Use the dedicated sidebar pages for source-aware rows and rollups."
    />

    <!-- Registry-driven analyzer panel: collapses every analyzer tab into one
         dispatch. Bespoke viz panels render their custom body; the rest fall
         through to GenericTableAnalyzerPanel; pipelines own their lifecycle. -->
    <GscAnalyzerPanel
      v-if="activeTab && activePanel"
      :def="activeTab"
      :rows="analyzerRows"
      :meta="analyzerMeta"
      :query-ms="analyzerQueryMs"
      :loading="analyzerLoading"
      :error="analyzerError"
      :range="dateRange"
    />
  </GscDashboardPage>
</template>
