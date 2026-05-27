<script setup lang="ts">
// TODO: port from nuxtseo.com
defineProps<{ title?: string, subtitle?: string }>()
</script>

<template>
  <header class="gsc-site-page-header">
    <h1 v-if="title">
      {{ title }}
    </h1>
    <p v-if="subtitle">
      {{ subtitle }}
    </p>
    <slot />
  </header>
</template>
