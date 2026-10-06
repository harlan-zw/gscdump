<script setup lang="ts">
import type { QueryRow } from '../../src/shared/protocol'
import { formatMetric } from '../format'

const { queries } = defineProps<{ queries: QueryRow[] }>()
</script>

<template>
  <table class="queries">
    <thead>
      <tr>
        <th scope="col" class="query">
          Query
        </th>
        <th scope="col">
          Clicks
        </th>
        <th scope="col">
          Impressions
        </th>
        <th scope="col">
          CTR
        </th>
        <th scope="col">
          Position
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in queries" :key="row.query">
        <th scope="row" class="query" :title="row.query">
          {{ row.query }}
        </th>
        <td class="tabular">
          {{ formatMetric(row.clicks, 'clicks') }}
        </td>
        <td class="tabular">
          {{ formatMetric(row.impressions, 'impressions') }}
        </td>
        <td class="tabular">
          {{ formatMetric(row.ctr, 'ctr') }}
        </td>
        <td class="tabular">
          {{ formatMetric(row.position, 'position') }}
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.queries {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}

th,
td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--grid);
  text-align: right;
  white-space: nowrap;
}

thead th {
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}

th.query {
  width: 46%;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  font-weight: 400;
}

thead th.query {
  font-weight: 500;
}

tbody tr:last-child th,
tbody tr:last-child td {
  border-bottom: 0;
}
</style>
