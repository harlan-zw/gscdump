<script setup lang="ts">
interface ChangePointEntity {
  keyword: string
  page: string
  totalDays: number
  changeDate: string
  llr: number
  leftMean: number
  rightMean: number
  delta: number
  leftStddev: number
  rightStddev: number
  direction: 'improved' | 'worsened'
  series: Array<{ date: string, value: number }>
}

const props = defineProps<{ rows: unknown[] }>()
const entities = computed(() => props.rows as unknown as ChangePointEntity[])
</script>

<template>
  <ChangePointPanel :entities="entities" metric="position" />
</template>
