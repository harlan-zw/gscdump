<script setup lang="ts">
// Pages list for a site — top 100 from top_pages_28d with deep-links to the
// per-page detail. Cheap read (JSON rollup).

definePageMeta({ key: route => `site-pages-index:${route.params.id}` })

interface TopPageRow { url: string, clicks: number, impressions: number, sum_position: number }

const { siteId } = useGscCurrentSite()

const { period, compareMode, stableData, q: search, payload, loading, rows } = useGscRollupTable<TopPageRow>({
  siteId,
  rollupKey: 'top_pages_28d',
  filterField: 'url',
})

function hrefFor(url: string): string {
  return `/sites/${encodeURIComponent(siteId.value)}/pages/${encodeURIComponent(url)}`
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Pages' }]"
        title="Pages"
        icon="i-lucide-file"
        description="Top 100 pages by clicks over the selected window."
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
        v-model="search"
        icon="i-lucide-search"
        size="sm"
        placeholder="Filter URLs"
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
      No page rollup built yet.
    </div>
    <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <tr>
            <th class="px-4 py-2.5 text-left">
              URL
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
            :key="r.url"
            class="hover:bg-elevated/30 transition-colors"
          >
            <td class="px-4 py-2.5 max-w-[500px]">
              <div class="flex items-center gap-2">
                <span class="text-[11px] tabular-nums text-dimmed w-6 text-right shrink-0">
                  {{ i + 1 }}
                </span>
                <NuxtLink
                  :to="hrefFor(r.url)"
                  class="truncate block text-default hover:text-primary hover:underline"
                  :title="r.url"
                >
                  {{ r.url }}
                </NuxtLink>
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
