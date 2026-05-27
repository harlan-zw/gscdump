<script setup lang="ts">
// TODO: port from nuxtseo.com
defineProps<{ data?: unknown[], height?: number }>()
</script>

<template>
  <div class="gsc-performance-chart" :style="{ height: `${height ?? 200}px` }" />
</template>
