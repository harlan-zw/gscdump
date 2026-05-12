<script setup lang="ts">
// Queries list for a site — top 100 from top_keywords_28d with deep-links to
// the per-query detail. Cheap read (JSON rollup), so no DuckDB boot needed.

definePageMeta({ key: route => `site-queries-index:${route.params.id}` })

interface TopKeywordRow { query: string, clicks: number, impressions: number, sum_position: number }

const { siteId } = useGscCurrentSite()

const { period, compareMode, stableData, q, sort, toggleSort, payload, loading, rows } = useGscRollupTable<TopKeywordRow>({
  siteId,
  rollupKey: 'top_keywords_28d',
  filterField: 'query',
  defaultSort: { column: 'clicks', direction: 'desc' },
})

function hrefFor(keyword: string): string {
  return `/sites/${encodeURIComponent(siteId.value)}/queries/${encodeURIComponent(keyword)}`
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Queries' }]"
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
      </GscSitePageHeader>
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
