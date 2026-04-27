<script setup lang="ts">
defineOptions({ inheritAttrs: false })

/**
 * Deterministic skeleton loader that avoids SSR hydration mismatches.
 * Uses index-based pseudo-random sizing instead of Math.random().
 */
const {
  type = 'text',
  lines = 1,
  index = 0,
  base = 160,
  range = 80,
} = defineProps<{
  /** Skeleton shape: horizontal text bar, vertical chart bar, or circle */
  type?: 'text' | 'bar' | 'circle'
  /** Number of skeleton lines (text type only) */
  lines?: number
  /** Seed index for deterministic width/height variation */
  index?: number
  /** Base size in px — text: width, bar: height percent, circle: diameter */
  base?: number
  /** Variation range in px or percent */
  range?: number
}>()

const attrs = useAttrs()

// Deterministic pseudo-random: produces consistent values for the same index on server + client
function seededValue(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x) // 0..1
}

function textWidth(i: number): string {
  return `${Math.round(base + seededValue(i + index) * range)}px`
}

function barHeight(i: number): string {
  return `${Math.round(20 + Math.sin(i * 0.3) * 15 + seededValue(i + index) * 30)}%`
}
</script>

<template>
  <!-- Text rows (multiple lines = fragment, wrapped in div for class inheritance) -->
  <div v-if="type === 'text' && lines > 1" v-bind="attrs" class="flex flex-col gap-2">
    <div
      v-for="i in lines"
      :key="i"
      class="ui-skeleton rounded h-3"
      :style="{ width: textWidth(i) }"
    />
  </div>

  <!-- Single text row -->
  <div
    v-else-if="type === 'text'"
    v-bind="attrs"
    class="ui-skeleton rounded h-3"
    :style="{ width: textWidth(1) }"
  />

  <!-- Vertical chart bars -->
  <div
    v-else-if="type === 'bar'"
    v-bind="attrs"
    class="ui-skeleton rounded-t w-full mt-auto"
    :style="{ height: barHeight(index) }"
  />

  <!-- Circle -->
  <div
    v-else-if="type === 'circle'"
    v-bind="attrs"
    class="ui-skeleton rounded-full"
    :style="{ width: `${base}px`, height: `${base}px` }"
  />
</template>

<style scoped>
.ui-skeleton {
  background: linear-gradient(
    90deg,
    var(--ui-bg-accented) 0%,
    var(--ui-bg-elevated) 40%,
    var(--ui-bg-accented) 80%
  );
  background-size: 200% 100%;
  animation: ui-shimmer 1.8s ease-in-out infinite;
}

@keyframes ui-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
