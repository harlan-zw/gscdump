<script setup lang="ts">
interface BayesianCtrRow {
  keyword: string
  page: string
  clicks: number
  impressions: number
  observedCtr: number
  position: number
  bucket: number
  priorAlpha: number
  priorBeta: number
  bucketPriorMean: number
  posteriorMean: number
  posteriorSd: number
  ciLow: number
  ciHigh: number
  shrinkageDelta: number
  expectedClicksDelta: number
  significance: number
  classification: 'overperforming' | 'underperforming' | 'expected'
}

const props = defineProps<{ rows: unknown[] }>()
const rows = computed(() => props.rows as unknown as BayesianCtrRow[])
</script>

<template>
  <BayesianCtrPanel :rows="rows" />
</template>
