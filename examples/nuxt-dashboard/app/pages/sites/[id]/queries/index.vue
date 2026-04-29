<script setup lang="ts">
// Queries list for a site — top 100 from top_keywords_28d with deep-links to
// the per-query detail. Cheap read (JSON rollup), so no DuckDB boot needed.

definePageMeta({ key: route => `site-queries-index:${route.params.id}` })

interface TopKeywordRow { query: string, clicks: number, impressions: number, sum_position: number }

type Period = typeof PERIOD_PRESETS[number]['value']
type CompareMode = typeof COMPARE_OPTIONS[number]['value']

const route = useRoute()
const siteId = computed(() => String(route.params.id))
const currentSite = useGscSite(siteId)

const period = ref<Period>('28d')
const compareMode = ref<CompareMode>('none')
const stableData = ref(true)
const windowRange = computed(() => {
  const r = periodToDateRange(period.value, { stableData: stableData.value })
  return { start: r.start, end: r.end }
})

const { data: payload, loading } = useGscRollup<TopKeywordRow[]>(
  siteId,
  'top_keywords_28d',
  { range: windowRange },
)

// URL-synced table state (useGscTableState handles q/sort/page deep-linking).
const { q, sort, toggleSort } = useGscTableState({ defaultSort: { column: 'clicks', direction: 'desc' } })
const searchDebounced = ref('')
let handle: ReturnType<typeof setTimeout> | null = null
watch(q, (v) => {
  if (handle)
    clearTimeout(handle)
  handle = setTimeout(() => {
    searchDebounced.value = v
  }, 150)
})

function positionFor(r: TopKeywordRow): number {
  return r.impressions > 0 ? r.sum_position / r.impressions + 1 : 0
}

const rows = computed(() => {
  const needle = searchDebounced.value.trim().toLowerCase()
  const list = (payload.value ?? []).slice()
  const filtered = needle ? list.filter(r => r.query.toLowerCase().includes(needle)) : list
  const s = sort.value
  if (s) {
    const dir = s.direction === 'desc' ? -1 : 1
    filtered.sort((a, b) => {
      const av = s.column === 'position' ? positionFor(a) : (a as any)[s.column]
      const bv = s.column === 'position' ? positionFor(b) : (b as any)[s.column]
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0
    })
  }
  return filtered.slice(0, 100)
})

function hrefFor(keyword: string): string {
  return `/sites/${encodeURIComponent(siteId.value)}/queries/${encodeURIComponent(keyword)}`
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscPageHeader
        :crumbs="[
          { label: 'Overview', to: '/' },
          { label: currentSite?.hostname ?? siteId, to: `/sites/${encodeURIComponent(siteId)}` },
          { label: 'Queries' },
        ]"
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
      </GscPageHeader>
    </template>

    <SiteTabs :site-id="siteId" />

    <div class="flex items-center gap-3 flex-wrap rounded-lg border border-default bg-default px-3 py-2">
      <UInput
        v-model="q"
        icon="i-lucide-search"
        size="sm"
        placeholder="Filter queries"
        class="flex-1 min-w-[200px]"
      />
      <span class="ml-auto text-[11px] text-dimmed tabular-nums">
        {{ rows.length }} of {{ (payload?.length ?? 0).toLocaleString() }}
      </span>
    </div>

    <div v-if="loading && !payload" class="text-sm text-muted">
      Loading…
    </div>
    <div
      v-else-if="!payload?.length"
      class="rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted"
    >
      No keyword rollup built yet.
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
