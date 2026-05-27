<script setup lang="ts">
// Stub passthrough — full layout/chrome lives in nuxtseo.com.
// TODO: port from nuxtseo.com
defineProps<{ title?: string }>()
</script>

<template>
  <div class="gsc-dashboard-page flex flex-col min-h-screen">
    <slot name="header" />
    <slot />
  </div>
</template>
