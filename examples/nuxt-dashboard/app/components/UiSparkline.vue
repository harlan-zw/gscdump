<script setup lang="ts">
// Tiny inline SVG sparkline. No deps — values arrive as a number[], we polyline
// them across the SVG viewBox with a flat baseline when the series is empty
// or constant. Width/height/color/strokeWidth are all the chart needs to be
// recognisable next to a row.

const props = withDefaults(defineProps<{
  data: readonly number[]
  width?: number
  height?: number
  color?: string
  strokeWidth?: number
}>(), {
  width: 100,
  height: 20,
  color: 'currentColor',
  strokeWidth: 1.2,
})

const path = computed(() => {
  const pts = props.data
  if (!pts.length)
    return ''
  // Pad the top + bottom so the stroke isn't clipped at the viewBox edges.
  const padY = props.strokeWidth + 1
  const usableH = Math.max(1, props.height - padY * 2)
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const range = max - min || 1
  const stepX = pts.length > 1 ? props.width / (pts.length - 1) : 0
  return pts.map((v, i) => {
    const x = i * stepX
    // Invert Y because SVG `y` grows downward — high values should render up.
    const y = padY + (1 - (v - min) / range) * usableH
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
})
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    preserveAspectRatio="none"
    role="img"
    aria-label="Trend sparkline"
  >
    <path
      v-if="path"
      :d="path"
      fill="none"
      :stroke="color"
      :stroke-width="strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
