<script setup lang="ts">
interface VolatilityDay {
  date: string
  queryCount: number
  dayImpressions: number
  avgPosition: number
  posStddev: number
  bestPosition: number
  worstPosition: number
  dodShift: number
  volatility: number
}
interface VolatilityPage {
  page: string
  avgVolatility: number
  peakVolatility: number
  totalImpressions: number
  days: VolatilityDay[]
}

const props = defineProps<{ rows: unknown[], meta: Record<string, unknown> }>()
const pages = computed(() => props.rows as unknown as VolatilityPage[])
const dates = computed(() => (props.meta.dates as string[] | undefined) ?? [])
const maxVolatility = computed(() => typeof props.meta.maxVolatility === 'number' ? props.meta.maxVolatility : 1)
</script>

<template>
  <VolatilityHeatmap :pages="pages" :dates="dates" :max-volatility="maxVolatility" />
</template>
