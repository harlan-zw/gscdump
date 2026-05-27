<script setup lang="ts">
import type { GscAnalyzerDefinition } from '../../types'
// TODO: port from nuxtseo.com
defineProps<{ def?: GscAnalyzerDefinition }>()
</script>

<template>
  <div class="gsc-analyzer-panel">
    <slot />
  </div>
</template>
