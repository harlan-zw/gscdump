<script setup lang="ts">
// Indexing tab: summary card (indexed / excluded / fail counts) from the
// indexing_metadata rollup + a searchable table of URL-inspection records.
// Both come from entity-store JSON — no DuckDB boot needed.

import type { InspectionRecord } from '@gscdump/engine/entities'
import { hashUrl } from '@gscdump/engine/entities'

definePageMeta({ key: route => `site-indexing:${route.params.id}` })

const route = useRoute()
const siteId = computed(() => String(route.params.id))

const currentSite = useGscSite(siteId)

const { records, statusCounts, loading } = useGscInspections(siteId)
const { envelope: metadata } = useGscRollup<{
  totals: { updates: number, removes: number }
  latestUpdate?: string
  latestRemove?: string
  days: Array<{ date: string, updates: number, removes: number }>
}>(siteId, 'indexing_metadata')

// URL-synced table state (useGscTableState handles q + status filter deep-linking).
const { q: search, filter } = useGscTableState<{ status: 'all' | 'PASS' | 'NEUTRAL' | 'FAIL' }>({
  defaultFilter: { status: 'all' },
})
const searchDebounced = ref('')
let handle: ReturnType<typeof setTimeout> | null = null
watch(search, (v) => {
  if (handle)
    clearTimeout(handle)
  handle = setTimeout(() => {
    searchDebounced.value = v
  }, 150)
})

const filtered = computed<InspectionRecord[]>(() => {
  const q = searchDebounced.value.trim().toLowerCase()
  let rows = records.value
  if (filter.value.status !== 'all')
    rows = rows.filter(r => r.indexStatus === filter.value.status)
  if (q) {
    rows = rows.filter(r =>
      r.url.toLowerCase().includes(q)
      || (r.coverageState ?? '').toLowerCase().includes(q),
    )
  }
  return rows.slice(0, 200)
})

function fmtDate(iso: string | undefined): string {
  if (!iso)
    return '–'
  return new Date(iso).toLocaleDateString()
}

function statusColor(status: string | undefined): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'PASS')
    return 'success'
  if (status === 'NEUTRAL')
    return 'warning'
  if (status === 'FAIL')
    return 'error'
  return 'neutral'
}

const builtAtRelative = computed(() => {
  const builtAt = metadata.value?.builtAt
  if (!builtAt)
    return null
  const ageHours = Math.floor((Date.now() - builtAt) / 3600_000)
  if (ageHours < 1)
    return 'just now'
  if (ageHours < 24)
    return `${ageHours}h ago`
  return `${Math.floor(ageHours / 24)}d ago`
})

const summary = computed(() => {
  const payload = metadata.value?.payload
  return {
    totalInspections: records.value.length,
    pass: statusCounts.value.PASS,
    fail: statusCounts.value.FAIL,
    neutral: statusCounts.value.NEUTRAL,
    totalUpdates: payload?.totals.updates ?? 0,
    totalRemoves: payload?.totals.removes ?? 0,
    latestUpdate: payload?.latestUpdate,
    latestRemove: payload?.latestRemove,
  }
})
</script>

<template>
  <GscDashboardPage gap="lg">
    <template #header>
      <GscPageHeader
        :crumbs="[
          { label: 'Overview', to: '/' },
          { label: currentSite?.hostname ?? siteId, to: `/sites/${encodeURIComponent(siteId)}` },
          { label: 'Indexing' },
        ]"
        title="Indexing"
        icon="i-lucide-file-check"
        description="URL inspection state + Indexing API notifications for this site."
      />
    </template>

    <SiteTabs :site-id="siteId" />

    <GscGhostPanel
      :site-id="siteId"
      requires="sql"
      title="Indexing reports are a Pro feature"
      description="URL inspection state and indexing history require the stored parquet backend. Free accounts only see live Search Console metrics."
      cta-label="See plans"
      cta-href="/pricing"
    >
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-check-circle" class="size-3" /> Pass
          </div>
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
            {{ summary.pass.toLocaleString() }}
          </div>
        </div>
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-alert-circle" class="size-3" /> Neutral
          </div>
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
            {{ summary.neutral.toLocaleString() }}
          </div>
        </div>
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-x-circle" class="size-3" /> Fail
          </div>
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
            {{ summary.fail.toLocaleString() }}
          </div>
        </div>
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-bell" class="size-3" /> API notifications
          </div>
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
            {{ (summary.totalUpdates + summary.totalRemoves).toLocaleString() }}
          </div>
          <div v-if="builtAtRelative" class="text-[11px] text-dimmed mt-1">
            rollup built {{ builtAtRelative }}
          </div>
        </div>
      </div>

      <div
        v-if="!loading && !records.length"
        class="rounded-lg border border-dashed border-default p-8 text-center"
      >
        <UIcon name="i-lucide-file-search" class="size-8 mx-auto text-dimmed mb-3" />
        <p class="text-sm text-muted">
          No URL inspections yet. Run
          <UKbd>gscdump entities inspect --site {{ siteId }} --file urls.txt</UKbd>
          to populate.
        </p>
      </div>

      <template v-else>
        <div class="flex items-center gap-3 flex-wrap rounded-lg border border-default bg-default px-3 py-2">
          <UInput
            v-model="search"
            icon="i-lucide-search"
            size="sm"
            placeholder="Filter URLs or coverage state"
            class="flex-1 min-w-[200px]"
          />
          <div class="flex items-center gap-1 text-xs">
            <span class="text-[11px] font-semibold text-dimmed uppercase tracking-widest mr-1">status</span>
            <button
              v-for="opt in (['all', 'PASS', 'NEUTRAL', 'FAIL'] as const)"
              :key="opt"
              class="px-2 py-1 rounded-md text-xs transition-colors"
              :class="filter.status === opt
                ? 'bg-elevated text-default font-medium'
                : 'text-muted hover:text-default hover:bg-elevated/50'"
              @click="filter.status = opt"
            >
              {{ opt === 'all' ? 'All' : opt.toLowerCase() }}
            </button>
          </div>
          <span class="ml-auto text-[11px] text-dimmed tabular-nums">
            {{ filtered.length.toLocaleString() }} of {{ summary.totalInspections.toLocaleString() }}
          </span>
        </div>

        <div class="rounded-lg border border-default bg-default overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
                <tr>
                  <th class="px-4 py-2.5 text-left">
                    URL
                  </th>
                  <th class="px-4 py-2.5 text-left w-[100px]">
                    Status
                  </th>
                  <th class="px-4 py-2.5 text-left">
                    Coverage
                  </th>
                  <th class="px-4 py-2.5 text-right w-[140px]">
                    Last crawled
                  </th>
                  <th class="px-4 py-2.5 text-right w-[140px]">
                    Inspected
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="r in filtered" :key="r.url" class="hover:bg-elevated/30 transition-colors">
                  <td class="px-4 py-2.5 max-w-[400px]">
                    <NuxtLink
                      :to="`/sites/${encodeURIComponent(siteId)}/indexing/${hashUrl(r.url)}`"
                      class="truncate text-default block hover:text-primary"
                      :title="r.url"
                    >
                      {{ r.url }}
                    </NuxtLink>
                    <div v-if="r.googleCanonical && r.googleCanonical !== r.url" class="text-[11px] text-dimmed truncate" :title="`Google canonical: ${r.googleCanonical}`">
                      → {{ r.googleCanonical }}
                    </div>
                  </td>
                  <td class="px-4 py-2.5">
                    <UBadge :color="statusColor(r.indexStatus)" variant="soft" size="xs">
                      {{ r.indexStatus ?? '–' }}
                    </UBadge>
                  </td>
                  <td class="px-4 py-2.5 text-muted text-[12px]">
                    {{ r.coverageState ?? '–' }}
                  </td>
                  <td class="px-4 py-2.5 text-right text-muted tabular-nums text-[12px]">
                    {{ fmtDate(r.lastCrawlTime) }}
                  </td>
                  <td class="px-4 py-2.5 text-right text-muted tabular-nums text-[12px]">
                    {{ fmtDate(r.inspectedAt) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </GscGhostPanel>
  </GscDashboardPage>
</template>
