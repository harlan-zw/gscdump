<script setup lang="ts">
// Countries tab: per-country breakdown. Hits a server endpoint that branches
// on tier — free tier queries GSC API live, pro tier aggregates parquet via
// DuckDB. The page doesn't care which backend served the row; same shape.

definePageMeta({ key: route => `site-countries:${route.params.id}` })

const { siteId } = useGscCurrentSite()

const { period, compareMode, stableData, range } = useGscPeriod()

const bootError = ref<Error | null>(null)

const windowRange = computed(() => ({ start: range.value.start, end: range.value.end }))
const { rows, loading, error: queryError } = useGscCountries(siteId, windowRange)
const error = computed(() => queryError.value?.message ?? null)

const totals = computed(() => {
  let clicks = 0
  let impressions = 0
  for (const r of rows.value) {
    clicks += r.clicks
    impressions += r.impressions
  }
  return { clicks, impressions }
})

const maxClicks = computed(() => rows.value.reduce((m: number, r: { clicks: number }) => r.clicks > m ? r.clicks : m, 0) || 1)

function displayName(code: string): string {
  if (code.length === 3)
    return countryName(code.toUpperCase()) || code.toUpperCase()
  return countryName(code.toUpperCase()) || code
}

function flagEmoji(code: string): string {
  // Many GSC exports use 3-letter codes; naive 2-letter mapping is good enough
  // for the top countries. Fall back to a globe when we can't derive.
  if (code.length !== 2)
    return '🌐'
  const upper = code.toUpperCase()
  const codePoints = [...upper].map(c => 127397 + c.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Countries' }]"
        title="Countries"
        icon="i-lucide-globe"
        description="Search performance by searcher country."
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
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-alert-circle"
      :title="error"
    />

    <div v-if="loading && !rows.length" class="text-sm text-muted">
      Loading…
    </div>

    <div
      v-else-if="!rows.length"
      class="rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted"
    >
      No country data in the selected period.
    </div>

    <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <tr>
            <th class="px-4 py-2.5 text-left">
              Country
            </th>
            <th class="px-4 py-2.5 text-left">
              Share
            </th>
            <th class="px-4 py-2.5 text-right w-[110px]">
              Clicks
            </th>
            <th class="px-4 py-2.5 text-right w-[130px]">
              Impressions
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
          <tr
            v-for="(r, i) in rows"
            :key="r.country"
            class="hover:bg-elevated/30 transition-colors"
          >
            <td class="px-4 py-2.5 max-w-[280px]">
              <div class="flex items-center gap-2">
                <span class="text-[11px] tabular-nums text-dimmed w-5 text-right shrink-0">
                  {{ i + 1 }}
                </span>
                <span class="text-base shrink-0">{{ flagEmoji(r.country) }}</span>
                <span class="truncate text-default" :title="r.country">{{ displayName(r.country) }}</span>
                <span class="text-[11px] text-dimmed font-mono shrink-0">{{ r.country.toUpperCase() }}</span>
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
            <td class="px-4 py-2.5 text-right tabular-nums text-muted">
              {{ r.impressions.toLocaleString() }}
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
