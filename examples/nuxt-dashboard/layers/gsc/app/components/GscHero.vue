<script setup lang="ts">
// TODO: port from nuxtseo.com
defineProps<{ title?: string }>()
</script>

<template>
  <section class="gsc-hero">
    <h2 v-if="title">
      {{ title }}
    </h2>
    <slot />
  </section>
</template>
