<script setup lang="ts">
// TODO: port from nuxtseo.com
defineProps<{ title?: string, subtitle?: string }>()
</script>

<template>
  <header class="gsc-section-header">
    <h2 v-if="title">
      {{ title }}
    </h2>
    <p v-if="subtitle">
      {{ subtitle }}
    </p>
    <slot />
  </header>
</template>
