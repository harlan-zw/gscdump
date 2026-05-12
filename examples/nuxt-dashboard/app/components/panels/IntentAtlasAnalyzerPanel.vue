<script setup lang="ts">
interface IntentCluster {
  clusterKey: string
  keywordCount: number
  totalImpressions: number
  totalClicks: number
  ctr: number
  avgPosition: number
  keywords: Array<{ query: string, impressions: number, position: number }>
}

const props = defineProps<{ rows: unknown[] }>()
const clusters = computed(() => props.rows as unknown as IntentCluster[])
</script>

<template>
  <IntentTreemap :clusters="clusters" />
</template>
