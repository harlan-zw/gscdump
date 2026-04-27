<script setup lang="ts">
// Shared date-range picker. Two-model component: `period` (rolling window)
// + `compareMode` (previous / year / none) + `stableData` (offset end date
// by GSC's stable-latency window).
//
// Ported from nuxtseo.com's ProDateRangePicker with the layer-specific
// coupling removed: no ProMetricLabel, no UiTooltip, no periodVizColors.
// Callers that need those refinements wrap the component; the picker is a
// self-contained consumer of useGscPeriod.

import type { CompareMode, Period } from '../composables/useGscPeriod'
import { COMPARE_OPTIONS, getPeriodLabel, PERIOD_PRESETS, periodToDateRange } from '../composables/useGscPeriod'

const period = defineModel<Period>('period', { required: true })
const compareMode = defineModel<CompareMode>('compareMode', { required: true })
const stableData = defineModel<boolean>('stableData', { required: true })

const open = ref(false)

const rangeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const rangeFmtYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const numFmt = new Intl.NumberFormat('en-US')

const dateRange = computed(() => periodToDateRange(period.value, stableData.value))

function formatRange(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00`)
  const e = new Date(`${end}T00:00:00`)
  if (s.getFullYear() !== e.getFullYear())
    return `${rangeFmtYear.format(s)} – ${rangeFmtYear.format(e)}`
  return `${rangeFmt.format(s)} – ${rangeFmtYear.format(e)}`
}

function selectPeriod(p: Period) {
  period.value = p
  open.value = false
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start', side: 'bottom', sideOffset: 8 }">
    <button
      :aria-label="`Date range: ${getPeriodLabel(period)}`"
      :aria-expanded="open"
      class="cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 border focus-visible:ring-2 focus-visible:ring-primary"
      :class="[
        open
          ? 'border-accented bg-elevated text-default'
          : 'border-default bg-muted text-muted hover:text-default hover:border-accented',
      ]"
    >
      <UIcon name="i-lucide-calendar" class="size-3.5" aria-hidden="true" />
      <span>{{ getPeriodLabel(period) }}</span>
      <span
        v-if="compareMode !== 'none'"
        class="text-[11px] px-1.5 py-0.5 rounded-sm font-semibold bg-elevated text-muted"
      >
        vs {{ compareMode === 'year' ? 'YoY' : 'prev' }}
      </span>
      <UIcon name="i-lucide-chevron-down" class="size-3 text-dimmed -mr-0.5" aria-hidden="true" />
    </button>

    <template #content>
      <div class="w-[min(440px,calc(100vw-2rem))]">
        <div class="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-default">
          <div class="sm:w-[190px] py-1.5" role="listbox" :aria-label="`Period presets, current: ${getPeriodLabel(period)}`">
            <div class="px-3 pt-1 pb-2">
              <span class="text-[10px] font-semibold text-dimmed uppercase tracking-widest">Rolling</span>
            </div>
            <div>
              <button
                v-for="preset in PERIOD_PRESETS"
                :key="preset.value"
                role="option"
                :aria-selected="period === preset.value"
                class="cursor-pointer group w-full flex items-center gap-2 pl-3 pr-3 py-[5px] text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset relative"
                :class="[
                  period === preset.value
                    ? 'text-default bg-elevated'
                    : 'text-muted hover:text-default hover:bg-elevated/50',
                ]"
                @click="selectPeriod(preset.value)"
              >
                <span
                  v-if="period === preset.value"
                  class="absolute left-0 inset-y-0.5 w-[2px] rounded-full bg-primary"
                />
                <span class="flex-1 text-left">{{ preset.label }}</span>
                <UIcon
                  v-if="period === preset.value"
                  name="i-lucide-check"
                  class="size-3 text-primary"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>

          <div class="flex-1 flex flex-col">
            <div class="px-3.5 pt-3 pb-2.5">
              <div class="flex items-baseline gap-2">
                <span class="text-[10px] font-semibold text-dimmed uppercase tracking-widest">Range</span>
                <span class="text-[10px] text-dimmed tabular-nums">{{ numFmt.format(dateRange.days) }}d</span>
              </div>
              <p class="text-[13px] font-semibold mt-1 tracking-tight">
                {{ formatRange(dateRange.start, dateRange.end) }}
              </p>
              <p
                v-if="compareMode !== 'none'"
                class="text-[11px] mt-1 flex items-center gap-1.5 text-muted opacity-70"
              >
                <span class="size-1 rounded-full bg-muted" />
                {{ formatRange(
                  compareMode === 'year' ? dateRange.yearStart : dateRange.prevStart,
                  compareMode === 'year' ? dateRange.yearEnd : dateRange.prevEnd,
                ) }}
              </p>
            </div>

            <div class="border-t border-default/50" role="separator" />

            <div class="px-3.5 py-2.5" role="radiogroup" aria-label="Comparison mode">
              <span class="text-[10px] font-semibold text-dimmed uppercase tracking-widest">Compare To</span>
              <div class="mt-1.5 flex flex-col gap-0.5">
                <button
                  v-for="opt in COMPARE_OPTIONS"
                  :key="opt.value"
                  role="radio"
                  :aria-checked="compareMode === opt.value"
                  class="cursor-pointer w-full flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                  :class="[
                    compareMode === opt.value
                      ? 'text-default bg-elevated'
                      : 'text-muted hover:text-default hover:bg-elevated/50',
                  ]"
                  @click="compareMode = opt.value"
                >
                  <span
                    class="size-3 rounded-full border-2 shrink-0 transition-colors"
                    :class="compareMode === opt.value ? 'border-primary bg-primary' : 'border-accented'"
                    aria-hidden="true"
                  />
                  <span class="flex-1 text-left">{{ opt.label }}</span>
                </button>
              </div>
            </div>

            <div class="border-t border-default/50" role="separator" />

            <div class="px-3.5 py-2.5">
              <div class="flex items-center justify-between">
                <span class="text-[10px] font-semibold text-dimmed uppercase tracking-widest" :title="stableData ? `End date offset by 3 days so Google has finished finalising metrics.` : 'End date is yesterday; recent days may be incomplete.'">Stable Data</span>
                <USwitch v-model="stableData" size="xs" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
