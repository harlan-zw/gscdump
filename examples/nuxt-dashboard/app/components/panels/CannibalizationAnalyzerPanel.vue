<script setup lang="ts">
interface CannibalGraph {
  nodes: Array<{ url: string, impressions: number, clicks: number, queryCount: number }>
  edges: Array<{ source: string, target: string, weight: number, queries: number }>
}
interface CannibalEvent {
  keyword: string
  competitors: Array<{ url: string, rank: number }>
  severity: number
}

const props = defineProps<{ rows: unknown[], meta: Record<string, unknown> }>()

const graph = computed<CannibalGraph | null>(() => (props.meta.graph as CannibalGraph | undefined) ?? null)
const events = computed<CannibalEvent[]>(() => props.rows as unknown as CannibalEvent[])
</script>

<template>
  <CannibalizationGraph
    v-if="graph"
    :nodes="graph.nodes"
    :edges="graph.edges"
    :events="events"
  />
</template>
