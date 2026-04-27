<script setup lang="ts">
// Reads a `top_*_28d` rollup directly from R2 and renders the top 10 rows.
// Zero DuckDB round-trip — the rollup pre-aggregated clicks over the
// trailing 28 days when sync last completed. Hidden when the rollup isn't
// built yet (dashboard still shows the live tables as the canonical view).

import { useGscRollup } from '../composables/useGscRollup'

interface TopPageRow { url: string, clicks: number, impressions: number, sum_position: number }
interface TopKeywordRow { query: string, clicks: number, impressions: number, sum_position: number }
type TopRow = TopPageRow | TopKeywordRow

const { siteIdentifier, rollupId, title, labelKey, hrefBase } = defineProps<{
  siteIdentifier: string | null | undefined
  rollupId: 'top_pages_28d' | 'top_keywords_28d'
  title: string
  // Field on each row to render as the label (e.g. 'url' or 'query')
  labelKey: 'url' | 'query'
  // Optional: if set, label becomes a link to `${hrefBase}${encodeURIComponent(label)}`
  hrefBase?: string
}>()

const { envelope, loading } = useGscRollup<TopRow[]>(() => siteIdentifier ?? null, () => rollupId)

const top10 = computed(() => (envelope.value?.payload ?? []).slice(0, 10))
const hasClicks = computed(() => top10.value.some((r: TopRow) => r.clicks > 0))

const builtAtRelative = computed(() => {
  const builtAt = envelope.value?.builtAt
  if (!builtAt)
    return null
  const ageMs = Date.now() - builtAt
  const hours = Math.floor(ageMs / 3600_000)
  if (hours < 1)
    return 'just now'
  if (hours < 24)
    return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
})
</script>

<template>
  <UCard v-if="loading || top10.length">
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <div>
          <h3 class="font-semibold">
            {{ title }}
          </h3>
          <p class="text-xs text-muted mt-0.5">
            Last 28 days<span v-if="builtAtRelative"> · built {{ builtAtRelative }}</span>
          </p>
        </div>
        <span class="text-[10px] font-mono uppercase text-cyan-400 border border-cyan-500/40 bg-cyan-500/5 px-1.5 py-0.5">
          rollup
        </span>
      </div>
    </template>

    <div v-if="loading && !top10.length" class="space-y-2">
      <USkeleton v-for="i in 5" :key="i" class="h-6" />
    </div>
    <div v-else-if="!hasClicks" class="text-sm text-muted py-4 text-center">
      No clicks in the last 28 days.
    </div>
    <div v-else class="space-y-1">
      <div
        v-for="(row, i) in top10"
        :key="String((row as any)[labelKey])"
        class="flex items-center justify-between gap-3 py-1 text-sm border-b border-default/40 last:border-0"
      >
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xs text-muted tabular-nums w-5 text-right">{{ i + 1 }}</span>
          <component
            :is="hrefBase ? 'NuxtLink' : 'span'"
            :to="hrefBase ? `${hrefBase}${encodeURIComponent(String((row as any)[labelKey]))}` : undefined"
            class="truncate"
            :class="hrefBase ? 'text-primary hover:underline' : ''"
          >
            {{ (row as any)[labelKey] }}
          </component>
        </div>
        <div class="flex items-center gap-3 text-xs shrink-0 tabular-nums text-muted">
          <span class="text-neutral-200">{{ row.clicks.toLocaleString() }}</span>
          <span>{{ row.impressions.toLocaleString() }} impr</span>
        </div>
      </div>
    </div>
  </UCard>
</template>
