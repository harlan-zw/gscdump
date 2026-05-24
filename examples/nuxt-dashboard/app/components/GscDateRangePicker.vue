<script setup lang="ts">
import type { CompareMode, Period } from '#imports'

const period = defineModel<Period>('period', { required: true })
const compareMode = defineModel<CompareMode>('compareMode', { required: true })
const stableData = defineModel<boolean>('stableData', { required: true })

const { presets, compareOptions } = useGscPeriod()
</script>

<template>
  <div class="flex items-center gap-2 flex-wrap">
    <USelect
      v-model="period"
      :items="presets.map(p => ({ label: p.label, value: p.value }))"
      size="sm"
      class="w-36"
    />
    <USelect
      v-model="compareMode"
      :items="compareOptions.map(o => ({ label: o.label, value: o.value }))"
      size="sm"
      class="w-40"
    />
    <UCheckbox
      v-model="stableData"
      label="Stable data"
      size="sm"
    />
  </div>
</template>
