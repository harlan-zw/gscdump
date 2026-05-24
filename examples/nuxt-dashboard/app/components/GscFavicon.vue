<script setup lang="ts">
const props = withDefaults(defineProps<{
  domain: string
  size?: number
  alt?: string
}>(), {
  size: 16,
  alt: '',
})

const src = computed(() => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(props.domain)}&sz=${props.size * 2}`)
</script>

<template>
  <img
    :src="src"
    :width="size"
    :height="size"
    :alt="alt"
    class="shrink-0 rounded-sm"
    loading="lazy"
  >
</template>
