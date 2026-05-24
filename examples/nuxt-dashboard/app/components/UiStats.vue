<script setup lang="ts">
interface StatItem {
  title: string
  value: string | number
  icon?: string
  trend?: number | null
  trendSuffix?: string
  invertTrend?: boolean
}

withDefaults(defineProps<{
  data: StatItem[]
  variant?: 'cards' | string
  layout?: 'grid' | string
}>(), {
  variant: 'cards',
  layout: 'grid',
})

function trendColor(item: StatItem): string {
  if (item.trend == null)
    return 'text-dimmed'
  const positive = item.invertTrend ? item.trend < 0 : item.trend > 0
  return positive ? 'text-success' : 'text-error'
}

function formatTrend(item: StatItem): string {
  if (item.trend == null)
    return '—'
  const value = item.trend * 100
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}${item.trendSuffix ?? ''}`
}
</script>

<template>
  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <div
      v-for="item in data"
      :key="item.title"
      class="rounded-lg border border-default bg-default px-4 py-3"
    >
      <div class="flex items-center justify-between gap-3 text-[12px] text-muted">
        <span>{{ item.title }}</span>
        <UIcon v-if="item.icon" :name="item.icon" class="size-4 text-dimmed" />
      </div>
      <div class="mt-2 flex items-end justify-between gap-3">
        <div class="text-2xl font-semibold tracking-tight text-default tabular-nums">
          {{ item.value }}
        </div>
        <div class="text-[12px] font-medium tabular-nums" :class="trendColor(item)">
          {{ formatTrend(item) }}
        </div>
      </div>
    </div>
  </div>
</template>
