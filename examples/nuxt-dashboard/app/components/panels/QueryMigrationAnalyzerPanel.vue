<script setup lang="ts">
interface MigrationEdge {
  sourcePage: string
  targetPage: string
  weight: number
  queryCount: number
  exactCount: number
  fuzzyCount: number
  examples: Array<{ sourceQuery: string, targetQuery: string, absorbed: number, matchType: 'exact' | 'fuzzy' }>
}
interface MigrationNode { url: string, outgoing: number, incoming: number }

const props = defineProps<{ rows: unknown[], meta: Record<string, unknown> }>()
const edges = computed(() => props.rows as unknown as MigrationEdge[])
const nodes = computed(() => (props.meta.nodes as MigrationNode[] | undefined) ?? [])
</script>

<template>
  <MigrationSankey :edges="edges" :nodes="nodes" />
</template>
