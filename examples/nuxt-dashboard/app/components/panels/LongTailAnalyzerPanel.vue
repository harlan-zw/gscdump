<script setup lang="ts">
interface LongTailRow {
  page: string
  queryCount: number
  totalImpressions: number
  totalClicks: number
  slope: number
  intercept: number
  r2: number
  headImpressions: number
  headShare: number
  fingerprint: 'flat-tail' | 'balanced' | 'head-heavy'
  points: Array<{ rank: number, impressions: number, clicks: number, query: string }>
}

const props = defineProps<{ rows: unknown[] }>()
const pages = computed(() => props.rows as unknown as LongTailRow[])
</script>

<template>
  <LongTailFingerprint :pages="pages" />
</template>
