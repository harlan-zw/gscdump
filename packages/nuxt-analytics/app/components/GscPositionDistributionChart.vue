<script setup lang="ts">
import { CurveType } from '@unovis/ts'
import { VisAxis, VisCrosshair, VisLine, VisTooltip, VisXYContainer } from '@unovis/vue'

interface DataPoint {
  date: string
  pos_1_3: number
  pos_4_10: number
  pos_11_20: number
  pos_20_plus: number
  total: number
}

defineProps<{
  data: DataPoint[]
  height?: number
}>()

const x = (_: DataPoint, i: number) => i
const pos1_3 = (d: DataPoint) => d.pos_1_3 ?? 0
const pos4_10 = (d: DataPoint) => d.pos_4_10 ?? 0
const pos11_20 = (d: DataPoint) => d.pos_11_20 ?? 0
const pos20plus = (d: DataPoint) => d.pos_20_plus ?? 0

const colors = {
  top3: '#10b981',
  page1: '#3b82f6',
  page2: '#f59e0b',
  deep: '#ef4444',
}

function template(d: DataPoint) {
  return `
  <div class="text-sm">
    <div class="font-medium mb-1">${d.date}</div>
    <div style="color: ${colors.top3}">Pos 1-3: ${d.pos_1_3?.toLocaleString() ?? 0}</div>
    <div style="color: ${colors.page1}">Pos 4-10: ${d.pos_4_10?.toLocaleString() ?? 0}</div>
    <div style="color: ${colors.page2}">Pos 11-20: ${d.pos_11_20?.toLocaleString() ?? 0}</div>
    <div style="color: ${colors.deep}">Pos 20+: ${d.pos_20_plus?.toLocaleString() ?? 0}</div>
    <div class="text-muted mt-1">Total: ${d.total?.toLocaleString() ?? 0}</div>
  </div>
`
}
</script>

<template>
  <div :style="{ height: `${height ?? 240}px` }">
    <VisXYContainer v-if="data?.length" :data="data" :height="height ?? 240">
      <VisLine :x="x" :y="pos1_3" :color="colors.top3" :line-width="2" :curve-type="CurveType.MonotoneX" />
      <VisLine :x="x" :y="pos4_10" :color="colors.page1" :line-width="2" :curve-type="CurveType.MonotoneX" />
      <VisLine :x="x" :y="pos11_20" :color="colors.page2" :line-width="2" :curve-type="CurveType.MonotoneX" />
      <VisLine :x="x" :y="pos20plus" :color="colors.deep" :line-width="2" :curve-type="CurveType.MonotoneX" />

      <VisAxis type="x" :tick-format="(i: number) => data[i]?.date?.slice(5) ?? ''" :num-ticks="7" />
      <VisAxis type="y" :tick-format="(n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n)" />
      <VisCrosshair :template="template" />
      <VisTooltip />
    </VisXYContainer>
    <div v-else class="flex items-center justify-center h-full text-muted text-sm">
      No data
    </div>
  </div>
</template>
