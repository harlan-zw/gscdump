<script setup lang="ts">
interface SurvivalCurvePoint { tenure: number, survival: number, atRisk: number, events: number }
interface SurvivalCohort {
  cohort: string
  episodeCount: number
  censoringRate: number
  medianTenure: number
  curve: SurvivalCurvePoint[]
}

const props = defineProps<{ rows: unknown[], meta: Record<string, unknown> }>()
const cohorts = computed(() => props.rows as unknown as SurvivalCohort[])
const windowDays = computed(() => typeof props.meta.windowDays === 'number' ? props.meta.windowDays : 180)
</script>

<template>
  <SurvivalPanel :cohorts="cohorts" :window-days="windowDays" />
</template>
