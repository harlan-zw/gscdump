<script setup lang="ts">
interface AnomalySeriesPoint {
  date: string
  ctr: number
  rollingCtr: number | null
  rollingStddev: number | null
  z: number
  breach: boolean
  impressions: number
  position: number
}
interface AnomalyRow {
  keyword: string
  page: string
  breachDaysDown: number
  breachDaysUp: number
  clicksLost: number
  maxZ: number
  baselineCtr: number
  baselinePosition: number
  totalImpressions: number
  totalClicks: number
  series: AnomalySeriesPoint[]
}

const props = defineProps<{ rows: unknown[] }>()
const anomalies = computed(() => props.rows as unknown as AnomalyRow[])
</script>

<template>
  <div class="anomaly-list">
    <div v-for="a in anomalies.slice(0, 30)" :key="`${a.keyword}|${a.page}`" class="anomaly-row">
      <div class="anomaly-meta">
        <div class="anomaly-kw">
          {{ a.keyword }}
        </div>
        <div class="anomaly-page">
          {{ a.page }}
        </div>
        <div class="anomaly-metrics">
          <span><b>{{ Math.round(a.clicksLost) }}</b> clicks lost</span>
          <span>·</span>
          <span><b>{{ a.breachDaysDown }}</b> breach days</span>
          <span>·</span>
          <span>max |z|=<b>{{ a.maxZ.toFixed(1) }}</b></span>
          <span>·</span>
          <span>pos <b>{{ a.baselinePosition.toFixed(1) }}</b></span>
        </div>
      </div>
      <AnomalyChart :series="a.series" />
    </div>
  </div>
</template>

<style scoped>
.anomaly-list { display: flex; flex-direction: column; gap: 0; max-height: 65vh; overflow-y: auto; border: 1px solid #f0f0f2; border-radius: 4px; }
.anomaly-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 1rem; padding: 0.7rem 0.9rem; border-bottom: 1px solid #f4f4f6; }
.anomaly-row:last-child { border-bottom: 0; }
.anomaly-row:hover { background: #fafafb; }
.anomaly-meta { min-width: 0; }
.anomaly-kw { font-weight: 600; font-size: 0.88rem; color: #1d1d1f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.anomaly-page { font-family: ui-monospace, monospace; font-size: 0.72rem; color: #7a6cd0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0.1rem 0 0.3rem; }
.anomaly-metrics { font-size: 0.74rem; color: #888; display: flex; gap: 0.4rem; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.anomaly-metrics b { color: #1d1d1f; font-weight: 600; }
</style>
