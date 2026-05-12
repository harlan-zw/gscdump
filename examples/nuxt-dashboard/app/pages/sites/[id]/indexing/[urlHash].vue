<script setup lang="ts">
// Per-URL inspection drill-down. Reads entities/inspections/history/*
// shards filtered to a single urlHash and renders a vertical timeline of
// every inspection we've persisted for that URL. Pro-tier only: the free
// tier never persists history.

import type { InspectionRecord } from '@gscdump/engine/entities'

definePageMeta({ key: route => `site-indexing-url:${route.params.id}:${route.params.urlHash}` })

const route = useRoute()
const { siteId } = useGscCurrentSite()
const urlHash = computed(() => String(route.params.urlHash))
const { records, url, loading } = useGscInspectionHistory(siteId, urlHash)

function fmtDateTime(iso: string | undefined): string {
  if (!iso)
    return '–'
  const d = new Date(iso)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
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

const latest = computed(() => records.value[records.value.length - 1])
const previous = computed(() => records.value.length > 1 ? records.value[records.value.length - 2] : undefined)

interface Change {
  field: string
  from: string | undefined
  to: string | undefined
}

function diff(a: InspectionRecord | undefined, b: InspectionRecord | undefined): Change[] {
  if (!a || !b)
    return []
  const fields = ['indexStatus', 'coverageState', 'robotsTxtState', 'indexingState', 'pageFetchState', 'mobileUsabilityVerdict', 'richResultsVerdict', 'googleCanonical', 'userCanonical'] as const
  const changes: Change[] = []
  for (const f of fields) {
    if (a[f] !== b[f])
      changes.push({ field: f, from: a[f], to: b[f] })
  }
  return changes
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[
          { label: 'Indexing', to: `/sites/${encodeURIComponent(siteId)}/indexing` },
          { label: url ?? urlHash },
        ]"
        :title="url ?? 'Unknown URL'"
        icon="i-lucide-file-search"
        :description="`Inspection timeline · ${records.length.toLocaleString()} record${records.length === 1 ? '' : 's'}`"
      >
        <template #actions>
          <UButton
            v-if="url"
            :to="url"
            target="_blank"
            size="xs"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-external-link"
          >
            Open URL
          </UButton>
        </template>
      </GscSitePageHeader>
    </template>

    <SiteTabs :site-id="siteId" />

    <div v-if="loading && !records.length" class="text-sm text-muted">
      Loading…
    </div>

    <div
      v-else-if="!records.length"
      class="rounded-lg border border-dashed border-default p-8 text-center"
    >
      <UIcon name="i-lucide-history" class="size-8 mx-auto text-dimmed mb-3" />
      <p class="text-sm text-muted">
        No inspection history for this URL yet. Run
        <UKbd>gscdump entities inspect --site {{ siteId }} --file urls.txt</UKbd>
        at least twice to build a timeline.
      </p>
    </div>

    <template v-else>
      <div v-if="latest" class="rounded-lg border border-default bg-default p-5">
        <GscSectionHeader title="Latest inspection" :description="fmtDateTime(latest.inspectedAt)" icon="i-lucide-zap" />
        <dl class="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
          <div>
            <dt class="text-[11px] font-semibold text-dimmed uppercase tracking-widest">
              Verdict
            </dt>
            <dd class="mt-1">
              <UBadge :color="statusColor(latest.indexStatus)" variant="soft" size="xs">
                {{ latest.indexStatus ?? '–' }}
              </UBadge>
            </dd>
          </div>
          <div>
            <dt class="text-[11px] font-semibold text-dimmed uppercase tracking-widest">
              Coverage
            </dt>
            <dd class="mt-1 text-sm text-default">
              {{ latest.coverageState ?? '–' }}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] font-semibold text-dimmed uppercase tracking-widest">
              Last crawled
            </dt>
            <dd class="mt-1 text-sm text-default">
              {{ fmtDateTime(latest.lastCrawlTime) }}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] font-semibold text-dimmed uppercase tracking-widest">
              Page fetch
            </dt>
            <dd class="mt-1 text-sm text-default">
              {{ latest.pageFetchState ?? '–' }}
            </dd>
          </div>
        </dl>
        <div v-if="diff(previous, latest).length" class="mt-4 pt-3 border-t border-default">
          <div class="text-[11px] font-semibold text-dimmed uppercase tracking-widest mb-2">
            Changed since previous inspection
          </div>
          <ul class="text-sm space-y-1">
            <li v-for="c in diff(previous, latest)" :key="c.field" class="flex items-center gap-2">
              <span class="text-muted text-[12px] min-w-[140px]">{{ c.field }}</span>
              <span class="text-dimmed text-[12px] line-through">{{ c.from ?? '–' }}</span>
              <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
              <span class="text-default text-[12px]">{{ c.to ?? '–' }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div class="rounded-lg border border-default bg-default overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
              <tr>
                <th class="px-4 py-2.5 text-left w-[180px]">
                  Inspected
                </th>
                <th class="px-4 py-2.5 text-left w-[100px]">
                  Verdict
                </th>
                <th class="px-4 py-2.5 text-left">
                  Coverage
                </th>
                <th class="px-4 py-2.5 text-left">
                  Indexing
                </th>
                <th class="px-4 py-2.5 text-right w-[160px]">
                  Last crawled
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="(r, i) in [...records].reverse()" :key="`${r.inspectedAt}-${i}`" class="hover:bg-elevated/30 transition-colors">
                <td class="px-4 py-2.5 text-muted tabular-nums text-[12px]">
                  {{ fmtDateTime(r.inspectedAt) }}
                </td>
                <td class="px-4 py-2.5">
                  <UBadge :color="statusColor(r.indexStatus)" variant="soft" size="xs">
                    {{ r.indexStatus ?? '–' }}
                  </UBadge>
                </td>
                <td class="px-4 py-2.5 text-muted text-[12px]">
                  {{ r.coverageState ?? '–' }}
                </td>
                <td class="px-4 py-2.5 text-muted text-[12px]">
                  {{ r.indexingState ?? '–' }}
                </td>
                <td class="px-4 py-2.5 text-right text-muted tabular-nums text-[12px]">
                  {{ fmtDateTime(r.lastCrawlTime) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </GscDashboardPage>
</template>
