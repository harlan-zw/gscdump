<script setup lang="ts">
// Per-sitemap history page. Plots submitted vs. indexed counts over time
// from the immutable `entities/sitemaps/history/<hash>__<ms>.json` docs
// plus a table of raw snapshots. Line chart uses the same Unovis stack as
// the position-distribution chart so we stay on one charting dependency.

import type { SitemapRecord } from '@gscdump/engine/entities'
import { CurveType } from '@unovis/ts'
import { VisAxis, VisCrosshair, VisLine, VisTooltip, VisXYContainer } from '@unovis/vue'

definePageMeta({ key: route => `site-sitemap-detail:${route.params.id}:${route.params.feedpathHash}` })

const route = useRoute()
const { siteId } = useGscCurrentSite()
const feedpathHash = computed(() => String(route.params.feedpathHash))
const { snapshots, path, loading } = useGscSitemapHistory(siteId, feedpathHash)

function submittedTotal(record: SitemapRecord): number {
  let sum = 0
  for (const c of record.contents ?? []) sum += Number(c.submitted ?? 0)
  return sum
}

function indexedTotal(record: SitemapRecord): number {
  let sum = 0
  for (const c of record.contents ?? []) sum += Number(c.indexed ?? 0)
  return sum
}

interface Point {
  date: string
  capturedAt: string
  submitted: number
  indexed: number
  errors: number
  warnings: number
}

const points = computed<Point[]>(() =>
  snapshots.value.map(s => ({
    date: s.capturedAt.slice(0, 10),
    capturedAt: s.capturedAt,
    submitted: submittedTotal(s),
    indexed: indexedTotal(s),
    errors: Number(s.errors ?? 0),
    warnings: Number(s.warnings ?? 0),
  })),
)

const colors = {
  submitted: '#3b82f6',
  indexed: '#10b981',
}

const xFn = (_: Point, i: number) => i
const submitted = (d: Point) => d.submitted
const indexed = (d: Point) => d.indexed

function tooltip(d: Point) {
  return `
  <div class="text-sm">
    <div class="font-medium mb-1">${d.date}</div>
    <div style="color: ${colors.submitted}">Submitted: ${d.submitted.toLocaleString()}</div>
    <div style="color: ${colors.indexed}">Indexed: ${d.indexed.toLocaleString()}</div>
    ${d.errors > 0 ? `<div class="text-error mt-1">Errors: ${d.errors}</div>` : ''}
  </div>
`
}

function fmtDateTime(iso: string | undefined): string {
  if (!iso)
    return '–'
  const d = new Date(iso)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

const latest = computed(() => snapshots.value[snapshots.value.length - 1])

const delta = computed(() => {
  if (snapshots.value.length < 2)
    return null
  const first = snapshots.value[0]!
  const last = snapshots.value[snapshots.value.length - 1]!
  return {
    submitted: submittedTotal(last) - submittedTotal(first),
    indexed: indexedTotal(last) - indexedTotal(first),
    spanDays: Math.max(1, Math.round((Date.parse(last.capturedAt) - Date.parse(first.capturedAt)) / 86400000)),
  }
})
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscSitePageHeader
        :tail="[
          { label: 'Sitemaps', to: `/sites/${encodeURIComponent(siteId)}/sitemaps` },
          { label: path ?? feedpathHash },
        ]"
        :title="path ?? 'Sitemap'"
        icon="i-lucide-map"
        :description="`${snapshots.length.toLocaleString()} snapshot${snapshots.length === 1 ? '' : 's'}${delta ? ` · over ${delta.spanDays} day${delta.spanDays === 1 ? '' : 's'}` : ''}`"
      >
        <template #actions>
          <UButton
            v-if="path"
            :to="path"
            target="_blank"
            size="xs"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-external-link"
          >
            Open sitemap
          </UButton>
        </template>
      </GscSitePageHeader>
    </template>

    <SiteTabs :site-id="siteId" />

    <div v-if="loading && !snapshots.length" class="text-sm text-muted">
      Loading…
    </div>

    <div
      v-else-if="!snapshots.length"
      class="rounded-lg border border-dashed border-default p-8 text-center"
    >
      <UIcon name="i-lucide-history" class="size-8 mx-auto text-dimmed mb-3" />
      <p class="text-sm text-muted">
        No snapshot history yet. Run
        <UKbd>gscdump entities sitemaps snapshot --site {{ siteId }}</UKbd>
        at least twice to build a timeline.
      </p>
    </div>

    <template v-else>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-upload" class="size-3" /> Submitted
          </div>
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
            {{ latest ? submittedTotal(latest).toLocaleString() : '–' }}
          </div>
          <div v-if="delta" class="text-[11px] mt-1 tabular-nums" :class="delta.submitted > 0 ? 'text-success' : delta.submitted < 0 ? 'text-error' : 'text-dimmed'">
            {{ delta.submitted > 0 ? '+' : '' }}{{ delta.submitted.toLocaleString() }} since first snapshot
          </div>
        </div>
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-check" class="size-3" /> Indexed
          </div>
          <div class="text-2xl font-semibold text-default tabular-nums tracking-tight mt-1.5">
            {{ latest ? indexedTotal(latest).toLocaleString() : '–' }}
          </div>
          <div v-if="delta" class="text-[11px] mt-1 tabular-nums" :class="delta.indexed > 0 ? 'text-success' : delta.indexed < 0 ? 'text-error' : 'text-dimmed'">
            {{ delta.indexed > 0 ? '+' : '' }}{{ delta.indexed.toLocaleString() }} since first snapshot
          </div>
        </div>
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-alert-triangle" class="size-3" /> Errors
          </div>
          <div class="text-2xl font-semibold tabular-nums tracking-tight mt-1.5" :class="Number(latest?.errors ?? 0) > 0 ? 'text-error' : 'text-default'">
            {{ latest?.errors ?? 0 }}
          </div>
        </div>
        <div class="rounded-lg border border-default bg-default p-4">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
            <UIcon name="i-lucide-clock" class="size-3" /> Last downloaded
          </div>
          <div class="text-sm text-default mt-1.5">
            {{ fmtDateTime(latest?.lastDownloaded) }}
          </div>
        </div>
      </div>

      <div class="rounded-lg border border-default bg-default p-5">
        <GscSectionHeader title="Submitted vs. indexed" description="One point per snapshot run." icon="i-lucide-trending-up" />
        <div class="mt-3" style="height: 240px;">
          <VisXYContainer v-if="points.length" :data="points" :height="240">
            <VisLine :x="xFn" :y="submitted" :color="colors.submitted" :line-width="2" :curve-type="CurveType.MonotoneX" />
            <VisLine :x="xFn" :y="indexed" :color="colors.indexed" :line-width="2" :curve-type="CurveType.MonotoneX" />
            <VisAxis type="x" :tick-format="(i: number) => points[i]?.date?.slice(5) ?? ''" :num-ticks="Math.min(7, points.length)" />
            <VisAxis type="y" :tick-format="(n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n)" />
            <VisCrosshair :template="tooltip" />
            <VisTooltip />
          </VisXYContainer>
          <div v-else class="flex items-center justify-center h-full text-muted text-sm">
            No data
          </div>
        </div>
        <div class="flex items-center gap-4 mt-2 text-[11px] text-muted">
          <span class="flex items-center gap-1.5"><span class="size-2 rounded-full" :style="{ background: colors.submitted }" /> Submitted</span>
          <span class="flex items-center gap-1.5"><span class="size-2 rounded-full" :style="{ background: colors.indexed }" /> Indexed</span>
        </div>
      </div>

      <div class="rounded-lg border border-default bg-default overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-elevated/50 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
              <tr>
                <th class="px-4 py-2.5 text-left w-[180px]">
                  Captured
                </th>
                <th class="px-4 py-2.5 text-right w-[110px]">
                  Submitted
                </th>
                <th class="px-4 py-2.5 text-right w-[110px]">
                  Indexed
                </th>
                <th class="px-4 py-2.5 text-right w-[80px]">
                  Errors
                </th>
                <th class="px-4 py-2.5 text-right w-[80px]">
                  Warnings
                </th>
                <th class="px-4 py-2.5 text-right w-[180px]">
                  Last downloaded
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="(s, i) in [...snapshots].reverse()" :key="`${s.capturedAt}-${i}`" class="hover:bg-elevated/30 transition-colors">
                <td class="px-4 py-2.5 text-muted tabular-nums text-[12px]">
                  {{ fmtDateTime(s.capturedAt) }}
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums text-[13px]">
                  {{ submittedTotal(s).toLocaleString() }}
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums text-[13px]">
                  {{ indexedTotal(s).toLocaleString() }}
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums text-[12px]" :class="Number(s.errors ?? 0) > 0 ? 'text-error' : 'text-muted'">
                  {{ s.errors ?? 0 }}
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums text-[12px]" :class="Number(s.warnings ?? 0) > 0 ? 'text-warning' : 'text-muted'">
                  {{ s.warnings ?? 0 }}
                </td>
                <td class="px-4 py-2.5 text-right text-muted tabular-nums text-[12px]">
                  {{ fmtDateTime(s.lastDownloaded) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </GscDashboardPage>
</template>
