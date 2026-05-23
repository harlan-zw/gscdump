<script setup lang="ts">
// `/analyze` page. Two flavours of tab, both registered through the same
// `useGscAnalyzerDefs()` list:
//   - Raw (pages, queries): typed SQL against attached parquet views, driven
//     by `useGscParquetTable` (layer composable owns the SQL DSL, paging,
//     debounce, count+page Promise.all). The raw-tab table render lives here
//     because it has features panels don't (metric column toggles + URL-
//     synced server-side sort + pagination).
//   - Every other tab: dispatched via `<GscAnalyzerPanel :def>` driven by
//     `def.capabilities.panel`. Panels with bespoke viz pick their own body
//     component; the rest get `GenericTableAnalyzerPanel`. Pipeline panels
//     (`actions`, `content-gap`) set `panel.ownsLifecycle` so the shell
//     skips its gating and they manage their own phase state.
//
// Adding a new analyzer = one-file change in `gscAnalyzers.ts`.

interface RawTab {
  kind: 'raw'
  id: 'pages' | 'queries'
  label: string
  table: 'pages' | 'keywords'
  dim: 'url' | 'query'
}

type Tab = RawTab | (GscAnalyzerDefinition & { table?: undefined, dim?: undefined })

const RAW_TABS: RawTab[] = [
  { kind: 'raw', id: 'pages', label: 'Pages', table: 'pages', dim: 'url' },
  { kind: 'raw', id: 'queries', label: 'Queries', table: 'keywords', dim: 'query' },
]

const analyzerDefs = useGscAnalyzerDefs()
const TABS = computed<Tab[]>(() => [...RAW_TABS, ...analyzerDefs])

const activeId = ref<string>('pages')
const activeTab = computed(() => TABS.value.find(t => t.id === activeId.value)!)

const { siteId } = useGscCurrentSite()

definePageMeta({ key: route => `site:${route.params.id}` })

const { period, compareMode, stableData, range: dateRange } = useGscPeriod()

const { runQuery, analyze, ready: isReady, error: bootError } = useGscSiteAnalyzer(siteId, dateRange)

// Provide the runner to pipeline panels (actions, content-gap). Pipeline
// composables (`useActionPriority`, `useContentGap`) hold their own state
// via `useState`, so panels can call them directly inside their setup().
provide(gscPanelRunnerKey, { runner: { query: runQuery, analyze }, ready: isReady })
const { data: dailyPayload } = useGscRollup<{ impressions: number, anonymizedImpressionsPct: number }[]>(siteId, 'daily_totals')
const anonymizationPct = computed(() => weightedAnonPct(dailyPayload.value))

const QUERY_GRAINED_TABS = computed(() => new Set<string>([
  'queries',
  ...analyzerDefs.filter(a => a.isQueryGrained).map(a => a.id),
]))
const showAnonymizationWarning = computed(() => QUERY_GRAINED_TABS.value.has(activeId.value))

const METRIC_COLS = ['clicks', 'impressions', 'ctr', 'avg_position'] as const
type MetricCol = typeof METRIC_COLS[number]
const visibleMetrics = ref<Record<MetricCol, boolean>>({
  clicks: true,
  impressions: true,
  ctr: true,
  avg_position: true,
})

const { q: search, sort, page, pageSize } = useGscTableState({
  defaultSort: { column: 'clicks', direction: 'desc' },
})

const rawTableName = computed(() => activeTab.value.kind === 'raw' ? activeTab.value.table : 'pages')
const rawDim = computed(() => activeTab.value.kind === 'raw' ? activeTab.value.dim : 'url')
const rawReady = computed(() => isReady.value && activeTab.value.kind === 'raw')
const raw = useGscParquetTable({
  table: rawTableName,
  dim: rawDim,
  query: runQuery,
  dateRange,
  q: search,
  sort,
  page,
  pageSize,
  ready: rawReady,
  triggers: [period, stableData],
})

// Analyzer-tab dispatch state. Separate from `raw` so the templates can pull
// data corresponding to the active tab without races.
const analyzerLoading = ref(false)
const analyzerError = ref<string | null>(null)
const analyzerRows = ref<unknown[]>([])
const analyzerMeta = ref<Record<string, unknown> | null>(null)
const analyzerQueryMs = ref<number | null>(null)

const activePanel = computed(() => {
  if (activeTab.value.kind === 'raw')
    return null
  return activeTab.value.capabilities?.panel ?? null
})

async function runActiveAnalyzer(): Promise<void> {
  if (activeTab.value.kind === 'raw')
    return
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
      type: activeTab.value.id,
      dateStart: start,
      dateEnd: end,
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
  page.value = 1
  search.value = ''
})

watch(
  [activeId, sort, period, stableData, isReady],
  () => {
    if (!isReady.value)
      return
    void runActiveAnalyzer()
  },
)

const queryMs = computed(() => activeTab.value.kind === 'raw' ? raw.queryMs.value : analyzerQueryMs.value)
const visibleRowCount = computed(() => activeTab.value.kind === 'raw' ? raw.rows.value.length : analyzerRows.value.length)
const totalRows = computed(() => activeTab.value.kind === 'raw' ? raw.totalRows.value : null)
const totalPages = computed(() => activeTab.value.kind === 'raw' ? raw.totalPages.value : null)

const rawSortColumns = computed(() => {
  const row = raw.rows.value[0]
  return row == null ? [] : Object.keys(row).filter(c => !METRIC_COLS.includes(c as MetricCol) || visibleMetrics.value[c as MetricCol])
})

function toggleRawSort(col: string): void {
  const cur = sort.value
  if (cur && cur.column === col)
    sort.value = { column: col, direction: cur.direction === 'desc' ? 'asc' : 'desc' }
  else
    sort.value = { column: col, direction: 'desc' }
  page.value = 1
}

function fmtCell(v: unknown): string {
  if (v == null)
    return ''
  if (typeof v === 'bigint')
    return v.toLocaleString()
  if (typeof v === 'number')
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
  return String(v)
}
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
          (!isReady || raw.loading.value || analyzerLoading) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        ]"
        :disabled="!isReady || raw.loading.value || analyzerLoading"
        @click="activeId = t.id"
      >
        {{ t.label }}
      </button>
      <span v-if="queryMs != null" class="ml-auto pl-2 text-[11px] font-mono text-dimmed tabular-nums whitespace-nowrap">
        {{ Math.round(queryMs) }} ms · {{ visibleRowCount }} rows
        <template v-if="totalRows != null"> of {{ totalRows.toLocaleString() }}</template>
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

    <template v-if="activeTab.kind === 'raw'">
      <div class="flex items-center gap-3 flex-wrap rounded-lg border border-default bg-default px-3 py-2">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          size="sm"
          :placeholder="`fuzzy ${(activeTab as RawTab).dim} search — space-separated tokens`"
          class="flex-1 min-w-[200px]"
          :ui="{ trailing: 'pr-1' }"
        >
          <template #trailing>
            <UButton
              v-if="search"
              color="neutral"
              variant="link"
              size="xs"
              icon="i-lucide-x"
              @click="search = ''"
            />
          </template>
        </UInput>
        <div class="flex items-center gap-3 text-xs">
          <span class="text-[11px] font-semibold text-dimmed uppercase tracking-widest">columns</span>
          <label v-for="col in METRIC_COLS" :key="col" class="flex items-center gap-1.5 cursor-pointer">
            <UCheckbox v-model="visibleMetrics[col]" size="xs" />
            <span class="text-muted tabular-nums">{{ col }}</span>
          </label>
        </div>
      </div>

      <section class="raw-panel">
        <div v-if="raw.loading.value" class="raw-loading">
          Running query…
        </div>
        <div v-else-if="raw.error.value" class="raw-err">
          {{ raw.error.value }}
        </div>
        <div v-else-if="raw.rows.value.length === 0 && isReady" class="raw-empty">
          No rows.
        </div>
        <div v-else-if="raw.rows.value.length > 0" class="raw-wrap">
          <table>
            <thead>
              <tr>
                <th
                  v-for="c in rawSortColumns"
                  :key="c"
                  class="sortable"
                  :class="{ active: sort?.column === c }"
                  @click="toggleRawSort(c)"
                >
                  {{ c }}
                  <span v-if="sort?.column === c" class="arrow">{{ sort.direction === 'desc' ? '▼' : '▲' }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in raw.rows.value" :key="i">
                <td
                  v-for="c in rawSortColumns"
                  :key="c"
                  :class="{ num: typeof row[c] === 'number' || typeof row[c] === 'bigint' }"
                >
                  {{ fmtCell(row[c]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div v-if="totalPages != null" class="pager">
        <button :disabled="page === 1 || raw.loading.value" @click="page = 1">
          ⟪
        </button>
        <button :disabled="page === 1 || raw.loading.value" @click="page--">
          ‹
        </button>
        <span>Page {{ page }} / {{ totalPages }}</span>
        <button :disabled="page >= totalPages || raw.loading.value" @click="page++">
          ›
        </button>
        <button :disabled="page >= totalPages || raw.loading.value" @click="page = totalPages">
          ⟫
        </button>
        <label class="pagesize">per page
          <select v-model.number="pageSize">
            <option :value="10">10</option>
            <option :value="25">25</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
      </div>
    </template>

    <!-- Registry-driven analyzer panel: collapses every analyzer tab into one
         dispatch. Bespoke viz panels render their custom body; the rest fall
         through to GenericTableAnalyzerPanel; pipelines own their lifecycle. -->
    <GscAnalyzerPanel
      v-else-if="activePanel"
      :def="(activeTab as GscAnalyzerDefinition)"
      :rows="analyzerRows"
      :meta="analyzerMeta"
      :query-ms="analyzerQueryMs"
      :loading="analyzerLoading"
      :error="analyzerError"
      :range="dateRange"
    />
  </GscDashboardPage>
</template>

<style scoped>
.raw-panel { background: var(--ui-bg); border: 1px solid var(--ui-border); border-radius: 8px; overflow: hidden; }
.raw-loading, .raw-empty { padding: 2.5rem; text-align: center; color: var(--ui-text-dimmed); font-size: 0.9rem; }
.raw-err { padding: 1rem 1.25rem; color: #c00; background: #fff5f5; font-family: ui-monospace, monospace; font-size: 0.82rem; white-space: pre-wrap; }
.raw-wrap { overflow-x: auto; max-height: 70vh; }
.raw-wrap table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.raw-wrap th, .raw-wrap td { padding: 0.45rem 0.85rem; border-bottom: 1px solid var(--ui-border); text-align: left; white-space: nowrap; }
.raw-wrap th { background: var(--ui-bg-elevated); font-weight: 600; position: sticky; top: 0; font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ui-text-dimmed); user-select: none; cursor: pointer; }
.raw-wrap th:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
.raw-wrap th.active { color: var(--ui-text-highlighted); }
.raw-wrap th .arrow { margin-left: 0.3em; font-size: 0.65rem; }
.raw-wrap td.num { font-variant-numeric: tabular-nums; text-align: right; }
.raw-wrap tbody tr:hover { background: var(--ui-bg-elevated); }

.pager { display: flex; gap: 0.4rem; align-items: center; padding: 0.6rem 0; font-size: 0.82rem; color: var(--ui-text-muted); }
.pager button { min-width: 2rem; padding: 0.3rem 0.6rem; border: 1px solid var(--ui-border); border-radius: 4px; background: var(--ui-bg); cursor: pointer; color: var(--ui-text); }
.pager button:disabled { opacity: 0.4; cursor: not-allowed; }
.pager .pagesize { margin-left: auto; display: inline-flex; align-items: center; gap: 0.4rem; color: var(--ui-text-dimmed); font-size: 0.78rem; }
.pager select { padding: 0.2rem 0.3rem; border: 1px solid var(--ui-border); border-radius: 4px; font-size: 0.82rem; background: var(--ui-bg); }
</style>
