<script setup lang="ts">
// Sitemaps tab: table of submitted sitemaps with last-download / status /
// per-content-type counts. Backed by the sitemap entity store written by
// `gscdump entities sitemaps snapshot`.

import { hashUrl } from '@gscdump/engine/entity-keys'

definePageMeta({ key: route => `site-sitemaps:${route.params.id}` })

const { siteId, site: currentSite } = useGscCurrentSite()

const { records, loading } = useGscSitemaps(siteId)

function fmtDate(iso: string | undefined): string {
  if (!iso)
    return '–'
  return new Date(iso).toLocaleDateString()
}

function submittedTotal(record: { contents?: Array<{ submitted?: string }> }): number {
  let sum = 0
  for (const c of record.contents ?? []) sum += Number(c.submitted ?? 0)
  return sum
}

function indexedTotal(record: { contents?: Array<{ indexed?: string }> }): number {
  let sum = 0
  for (const c of record.contents ?? []) sum += Number(c.indexed ?? 0)
  return sum
}

function sitemapStatus(record: { errors?: string, warnings?: string, isPending?: boolean }): {
  color: 'success' | 'warning' | 'error' | 'neutral'
  label: string
} {
  if (Number(record.errors ?? 0) > 0)
    return { color: 'error', label: `${record.errors} errors` }
  if (record.isPending)
    return { color: 'warning', label: 'pending' }
  if (Number(record.warnings ?? 0) > 0)
    return { color: 'warning', label: `${record.warnings} warnings` }
  return { color: 'success', label: 'ok' }
}

const summary = computed(() => {
  let submitted = 0
  let indexed = 0
  let withErrors = 0
  for (const r of records.value) {
    submitted += submittedTotal(r)
    indexed += indexedTotal(r)
    if (Number(r.errors ?? 0) > 0)
      withErrors++
  }
  return { count: records.value.length, submitted, indexed, withErrors }
})

const gscLink = computed(() =>
  currentSite.value
    ? gscConsoleUrl({
        siteLabel: currentSite.value.label,
        resource: 'sitemaps',
      })
    : null,
)
</script>

<template>
  <GscDashboardPage gap="lg">
    <template #header>
      <GscSitePageHeader
        :tail="[{ label: 'Sitemaps' }]"
        title="Sitemaps"
        icon="i-lucide-map"
        description="Submitted sitemap feeds and their most recent download status."
      >
        <template #actions>
          <UButton
            v-if="gscLink"
            :to="gscLink"
            target="_blank"
            size="xs"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-external-link"
          >
            Open in GSC
          </UButton>
        </template>
      </GscSitePageHeader>
    </template>

    <SiteTabs :site-id="siteId" />

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <UIcon name="i-lucide-files" class="size-3" /> Feeds
        </div>
        <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
          {{ summary.count.toLocaleString() }}
        </div>
      </div>
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <UIcon name="i-lucide-upload" class="size-3" /> Submitted
        </div>
        <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
          {{ summary.submitted.toLocaleString() }}
        </div>
      </div>
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <UIcon name="i-lucide-check" class="size-3" /> Indexed
        </div>
        <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
          {{ summary.indexed.toLocaleString() }}
        </div>
      </div>
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <UIcon name="i-lucide-alert-triangle" class="size-3" /> With errors
        </div>
        <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5" :class="summary.withErrors ? 'text-error' : ''">
          {{ summary.withErrors.toLocaleString() }}
        </div>
      </div>
    </div>

    <div
      v-if="loading && !records.length"
      class="text-sm text-muted"
    >
      Loading…
    </div>
    <div
      v-else-if="!records.length"
      class="rounded-lg border border-dashed border-default p-8 text-center"
    >
      <UIcon name="i-lucide-map" class="size-8 mx-auto text-dimmed mb-3" />
      <p class="text-sm text-muted">
        No sitemap snapshot yet. Run
        <UKbd>gscdump entities sitemaps snapshot --site {{ siteId }}</UKbd>
        to populate.
      </p>
    </div>

    <div v-else class="rounded-lg border border-default bg-default overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <tr>
              <th class="px-4 py-2.5 text-left">
                Feed
              </th>
              <th class="px-4 py-2.5 text-left w-[100px]">
                Type
              </th>
              <th class="px-4 py-2.5 text-left w-[120px]">
                Status
              </th>
              <th class="px-4 py-2.5 text-right w-[110px]">
                Submitted
              </th>
              <th class="px-4 py-2.5 text-right w-[110px]">
                Indexed
              </th>
              <th class="px-4 py-2.5 text-right w-[130px]">
                Last downloaded
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="r in records" :key="r.path" class="hover:bg-elevated/30 transition-colors">
              <td class="px-4 py-2.5 max-w-[360px]">
                <NuxtLink
                  :to="`/sites/${encodeURIComponent(siteId)}/sitemaps/${hashUrl(r.path)}`"
                  class="truncate text-default block hover:text-primary"
                  :title="r.path"
                >
                  {{ r.path }}
                </NuxtLink>
                <div v-if="r.isSitemapsIndex" class="text-[11px] text-dimmed">
                  index
                </div>
              </td>
              <td class="px-4 py-2.5 text-muted text-[12px]">
                {{ r.type ?? '–' }}
              </td>
              <td class="px-4 py-2.5">
                <UBadge :color="sitemapStatus(r).color" variant="soft" size="xs">
                  {{ sitemapStatus(r).label }}
                </UBadge>
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-[13px]">
                {{ submittedTotal(r).toLocaleString() }}
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-[13px]">
                {{ indexedTotal(r).toLocaleString() }}
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-[12px] text-muted">
                {{ fmtDate(r.lastDownloaded) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </GscDashboardPage>
</template>
