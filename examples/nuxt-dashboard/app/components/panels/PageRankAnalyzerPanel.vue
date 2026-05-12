<script setup lang="ts">
interface PageRankNode {
  kind: 'query' | 'url'
  id: string
  rank: number
  bridging: number
  anchoring: number
  degree: number
  impressions: number
}

const props = defineProps<{ rows: unknown[], meta: Record<string, unknown> }>()
const nodes = computed(() => props.rows as unknown as PageRankNode[])
const meta = computed(() => ({
  iterations: typeof props.meta.iterations === 'number' ? props.meta.iterations : 25,
  damping: typeof props.meta.damping === 'number' ? props.meta.damping : 0.85,
  convergenceDelta: typeof props.meta.convergenceDelta === 'number' ? props.meta.convergenceDelta : 0,
  queryCount: typeof props.meta.queryCount === 'number' ? props.meta.queryCount : 0,
  urlCount: typeof props.meta.urlCount === 'number' ? props.meta.urlCount : 0,
  deltas: (props.meta.deltas as Array<{ step: number, l1: number }> | undefined) ?? [],
}))
</script>

<template>
  <BipartitePageRankPanel :nodes="nodes" :meta="meta" />
</template>
