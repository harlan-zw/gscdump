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
  const r = periodToDateRange(period.value, stableData.value)
  return { start: r.start, end: r.end }
})

const { data: payload, loading } = useGscRollup<TopKeywordRow[]>(
  siteId,
  'top_keywords_28d',
  { range: windowRange },
)
const search = ref('')
const searchDebounced = ref('')
let handle: ReturnType<typeof setTimeout> | null = null
watch(search, (v) => {
  if (handle)
    clearTimeout(handle)
  handle = setTimeout(() => {
    searchDebounced.value = v
  }, 150)
})

const rows = computed(() => {
  const q = searchDebounced.value.trim().toLowerCase()
  const list = (payload.value ?? []).slice()
  const filtered = q ? list.filter(r => r.query.toLowerCase().includes(q)) : list
  return filtered.slice(0, 100)
})

function positionFor(r: TopKeywordRow): number {
  return r.impressions > 0 ? r.sum_position / r.impressions + 1 : 0
}

function hrefFor(keyword: string): string {
  return `/sites/${encodeURIComponent(siteId.value)}/queries/${encodeURIComponent(keyword)}`
}
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <header class="max-w-[1128px] px-4 sm:px-6 lg:px-9 border-b border-default pb-3">
      <div class="flex items-start gap-4 pt-5">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-xs text-dimmed mb-1">
            <NuxtLink to="/" class="hover:text-default">
              Overview
            </NuxtLink>
            <UIcon name="i-lucide-chevron-right" class="size-3" />
            <NuxtLink :to="`/sites/${encodeURIComponent(siteId)}`" class="hover:text-default">
              {{ currentSite?.hostname ?? siteId }}
            </NuxtLink>
            <UIcon name="i-lucide-chevron-right" class="size-3" />
            <span class="text-muted">Queries</span>
          </div>
          <h1 class="text-xl font-semibold tracking-tight text-default flex items-center gap-2">
            <UIcon name="i-lucide-search" class="size-4 text-dimmed" />
            Queries
          </h1>
          <p class="text-[13px] text-muted mt-0.5 leading-snug">
            Top 100 keywords by clicks over the selected window.
          </p>
        </div>
        <GscDateRangePicker
          v-model:period="period"
          v-model:compare-mode="compareMode"
          v-model:stable-data="stableData"
        />
      </div>
    </header>

    <div class="max-w-[1128px] px-4 sm:px-6 lg:px-9 pt-4 pb-10 flex flex-col gap-4 flex-1 w-full">
      <SiteTabs :site-id="siteId" />

      <div class="flex items-center gap-3 flex-wrap rounded-lg border border-default bg-default px-3 py-2">
        <UInput
          v-model="search"
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
              <th class="px-4 py-2.5 text-right w-[110px]">
                Clicks
              </th>
              <th class="px-4 py-2.5 text-right w-[130px]">
                Impressions
              </th>
              <th class="px-4 py-2.5 text-right w-[100px]">
                Avg. pos
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
    </div>
  </div>
</template>
