<script setup lang="ts">
// Lightweight favicon for a site label. Uses Google's public s2 service
// (same as nuxtseo.com's ProFavicon) — no local icon fetch, no sprite,
// one-to-one with the domain.

const { domain, size = 16, alt = '' } = defineProps<{
  /** Any site URL — bare hostname, sc-domain:, https://, etc. Normalised below. */
  domain: string
  size?: number
  alt?: string
}>()

const cleanDomain = computed(() =>
  domain
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, ''),
)
const src = computed(() => `https://www.google.com/s2/favicons?domain=${cleanDomain.value}&sz=128`)
</script>

<template>
  <img
    :src="src"
    :alt="alt"
    :width="size"
    :height="size"
    class="rounded-sm shrink-0"
  >
</template>
