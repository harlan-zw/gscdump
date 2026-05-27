<script setup lang="ts">
// TODO: port from nuxtseo.com
defineProps<{ keyword?: string, position?: number, href?: string }>()
</script>

<template>
  <span class="gsc-query-label inline-flex items-center gap-1">
    <NuxtLink v-if="href" :to="href" class="hover:text-primary">{{ keyword }}</NuxtLink>
    <span v-else>{{ keyword }}</span>
    <span v-if="position != null" class="text-dimmed tabular-nums">#{{ position.toFixed(1) }}</span>
  </span>
</template>
