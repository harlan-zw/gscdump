<script setup lang="ts">
const props = withDefaults(defineProps<{
  values: number[]
  width?: number
  height?: number
  stroke?: string
  fill?: string
}>(), {
  width: 96,
  height: 22,
  stroke: '#4c3ca0',
  fill: 'rgba(122, 108, 208, 0.15)',
})

const geometry = computed(() => {
  const vals = props.values.filter(v => typeof v === 'number' && Number.isFinite(v))
  if (vals.length < 2)
    return null
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const padY = 2
  const innerH = props.height - padY * 2
  const stepX = vals.length > 1 ? props.width / (vals.length - 1) : 0
  const points = vals.map((v, i) => {
    const x = i * stepX
    const y = padY + innerH - ((v - min) / span) * innerH
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const area = `0,${props.height} ${points.join(' ')} ${props.width},${props.height}`
  const last = points[points.length - 1]!.split(',').map(Number) as [number, number]
  return { line: points.join(' '), area, min, max, last }
})
</script>

<template>
  <svg
    v-if="geometry"
    :width="props.width"
    :height="props.height"
    :viewBox="`0 0 ${props.width} ${props.height}`"
    class="sparkline"
    preserveAspectRatio="none"
  >
    <polygon :points="geometry.area" :fill="props.fill" stroke="none" />
    <polyline :points="geometry.line" :stroke="props.stroke" fill="none" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" />
    <circle :cx="geometry.last[0]" :cy="geometry.last[1]" r="1.75" :fill="props.stroke" />
  </svg>
  <span v-else class="dim">—</span>
</template>

<style scoped>
.sparkline { display: inline-block; vertical-align: middle; }
.dim { color: #aaa; font-size: 0.75rem; }
</style>
