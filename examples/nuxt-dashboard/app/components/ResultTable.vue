<script setup lang="ts">
const props = withDefaults(defineProps<{
  rows: Record<string, unknown>[]
  maxRows?: number
}>(), { maxRows: 50 })

const displayed = computed(() => props.rows.slice(0, props.maxRows))
const columns = computed(() => {
  if (displayed.value.length === 0)
    return []
  return Object.keys(displayed.value[0]!)
})

function fmt(v: unknown): string {
  if (v == null)
    return ''
  if (typeof v === 'number')
    return v < 1 && v > 0 ? v.toFixed(3) : String(Math.round(v * 100) / 100)
  return String(v)
}
</script>

<template>
  <div v-if="props.rows.length === 0" class="empty">
    No rows.
  </div>
  <div v-else class="wrap">
    <table>
      <thead>
        <tr>
          <th v-for="col in columns" :key="col">
            {{ col }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in displayed" :key="i">
          <td v-for="col in columns" :key="col">
            {{ fmt(row[col]) }}
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="props.rows.length > maxRows" class="more">
      …and {{ props.rows.length - props.maxRows }} more
    </div>
  </div>
</template>

<style scoped>
.empty { padding: 2rem; color: #777; text-align: center; font-style: italic; }
.wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th, td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #eaeaec; text-align: left; white-space: nowrap; }
th { background: #fafafb; font-weight: 600; position: sticky; top: 0; }
td { font-variant-numeric: tabular-nums; }
.more { padding: 0.5rem 0.75rem; font-size: 0.78rem; color: #777; font-style: italic; }
</style>
