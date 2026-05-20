<script setup lang="ts">
// Surfaces the trailing-28d impression-weighted anonymization % from the
// daily_totals rollup. GSC anonymises queries for low-volume or sensitive
// terms, so query-grained breakdowns (keywords, pages-by-query) undercount
// impressions by this amount. Hidden when data isn't ready or the gap is
// negligible (<1%).

import { useGscRollup } from '../composables/useGscRollup'
import { weightedAnonPct } from '../utils/anonymization'

interface DailyTotal {
  impressions: number
  anonymizedImpressionsPct: number
}

const { siteIdentifier } = defineProps<{
  siteIdentifier: string | null | undefined
}>()

const { data: daily } = useGscRollup<DailyTotal[]>(() => siteIdentifier ?? null, 'daily_totals')

const formatted = computed(() => {
  if (!siteIdentifier)
    return null
  const pct = weightedAnonPct(daily.value)
  if (pct == null)
    return null
  const percent = pct * 100
  if (percent < 1)
    return null
  return percent.toFixed(percent < 10 ? 1 : 0)
})
</script>

<template>
  <div
    v-if="formatted"
    class="flex items-start gap-2 border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90"
  >
    <UIcon name="i-ph-info" class="mt-0.5 flex-shrink-0 text-amber-400" />
    <div>
      <span class="font-semibold">~{{ formatted }}% of impressions are anonymised by Google.</span>
      Query-grained breakdowns below exclude these, so the sum won't match site-level totals.
    </div>
  </div>
</template>
