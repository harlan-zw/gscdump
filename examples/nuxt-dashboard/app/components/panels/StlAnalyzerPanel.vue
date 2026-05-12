<script setup lang="ts">
interface StlEntity {
  keyword: string
  page: string
  totalImpressions: number
  days: number
  seasonalStrength: number
  trendStrength: number
  residualAnomalies: number
  trendSlope: number
  series: Array<{
    date: string
    observed: number
    trend: number | null
    seasonal: number | null
    residual: number | null
    anomaly: boolean
  }>
}

const props = defineProps<{ rows: unknown[] }>()
const entities = computed(() => props.rows as unknown as StlEntity[])
</script>

<template>
  <StlPanel :entities="entities" />
</template>
