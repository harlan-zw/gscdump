<script setup lang="ts">
const {
  to,
  icon,
  title,
  tooltip,
  tooltipDescription,
  value,
  suffix,
  valueClass,
  format,
  trend,
  trendSuffix,
  trendLabel,
  invertTrend,
  trendNeutral,
  sparkline,
  size = 'md',
  loading,
  status,
  card,
} = defineProps<UiStatProps>()

// Stat card primitive. Ported from nuxtseo/core with two swaps:
//  - ProNavIcon → UIcon (Nuxt UI)
//  - UiHelpLabel (→ UiTooltip → UiPopover + useMarkdown) → inline UTooltip
// Behavior + slots kept identical so consumers port cleanly.

// NuxtLink auto-registers globally; resolve by name so we don't depend on
// the `#components` virtual (which doesn't narrow nicely in a layer).
const NuxtLink = resolveComponent('NuxtLink')

type Datum = Record<string, number | string>

export interface UiStatProps {
  // link
  to?: string

  // label
  icon?: string
  title?: string
  tooltip?: string
  tooltipDescription?: string

  // value
  value?: string | number | null
  suffix?: string
  valueClass?: string
  format?: (n: number) => string

  // trend
  trend?: number | null
  trendSuffix?: string
  trendLabel?: string
  invertTrend?: boolean
  trendNeutral?: boolean

  // sparkline
  sparkline?: Datum[]

  // sizing
  size?: 'sm' | 'md' | 'lg'

  // state
  loading?: boolean

  // threshold alerting
  status?: 'crisis' | 'warning' | 'good'

  // render the value area inside a card, keeping the header outside
  card?: boolean
}

const hydrated = ref(false)
onMounted(() => {
  hydrated.value = true
})
const isLoading = computed(() => hydrated.value && loading)

const rootTag = computed(() => to ? NuxtLink : 'div')

const sizeConfig = computed(() => {
  const map = {
    sm: { value: 'text-xl', sparkW: 96, sparkH: 32 },
    md: { value: 'text-2xl', sparkW: 120, sparkH: 32 },
    lg: { value: 'text-3xl', sparkW: 160, sparkH: 36 },
  }
  return map[size]
})

const displayValue = computed(() => {
  if (value == null)
    return null
  if (format && typeof value === 'number')
    return format(value)
  return String(value)
})

const trendDirection = computed(() => {
  if (trend == null || trend === 0)
    return 'neutral'
  return trend > 0 ? 'up' : 'down'
})

const isTrendPositive = computed(() => {
  if (trendDirection.value === 'neutral')
    return null
  return invertTrend
    ? trendDirection.value === 'down'
    : trendDirection.value === 'up'
})

const trendColorClass = computed(() => {
  if (trendNeutral || isTrendPositive.value === null)
    return 'text-muted'
  return isTrendPositive.value ? 'text-success' : 'text-error'
})

const sparklineColor = computed(() => {
  if (trendNeutral)
    return semanticColors.neutral.hex
  if (isTrendPositive.value === null)
    return undefined
  return isTrendPositive.value ? semanticColors.success.hex : semanticColors.error.hex
})

const statusChip = computed(() => {
  if (!status)
    return null
  const map: Record<string, { label: string, dot: string, bg: string, text: string }> = {
    crisis: { label: 'Critical', dot: 'bg-error', bg: 'bg-error/10', text: 'text-error' },
    warning: { label: 'Needs work', dot: 'bg-warning', bg: 'bg-warning/10', text: 'text-warning' },
    good: { label: 'Healthy', dot: 'bg-success', bg: 'bg-success/10', text: 'text-success' },
  }
  return map[status] ?? null
})

const formattedTrend = computed(() => {
  if (trend == null)
    return ''
  const abs = Math.abs(trend)
  const sign = trend > 0 ? '+' : trend < 0 ? '-' : ''
  const formatted = format ? format(abs) : abs % 1 === 0 ? String(abs) : abs.toFixed(1)
  return `${sign}${formatted}${trendSuffix || ''}`
})
</script>

<template>
  <component
    :is="rootTag"
    :to="to || undefined"
    data-ui="UiStat"
    class="relative flex flex-col"
    :class="[
      card ? 'gap-2' : 'gap-1',
      to ? 'cursor-pointer' : '',
    ]"
  >
    <!-- Header: icon + label + trend + status chip -->
    <div
      class="flex items-center gap-1.5"
      :class="to && !card ? 'transition-opacity hover:opacity-80' : ''"
    >
      <slot name="icon">
        <UIcon v-if="icon" :name="icon" class="size-3 text-dimmed shrink-0" />
      </slot>
      <slot name="title">
        <UTooltip v-if="tooltip && title" :text="tooltipDescription || tooltip">
          <span class="inline-flex items-center gap-1 text-[10px] font-semibold text-dimmed uppercase tracking-[0.12em]">
            {{ title }}
            <UIcon name="i-lucide-circle-help" class="size-3 opacity-50 shrink-0" />
          </span>
        </UTooltip>
        <span v-else-if="title" class="text-[10px] font-semibold text-dimmed uppercase tracking-[0.12em]">{{ title }}</span>
      </slot>
      <slot v-if="!card" name="trend">
        <span v-if="trend != null && trend !== 0" class="text-xs font-medium font-mono tabular-nums" :class="trendColorClass">
          {{ formattedTrend }}
        </span>
        <span v-if="trendLabel" class="text-xs text-dimmed">{{ trendLabel }}</span>
      </slot>
      <span
        v-if="statusChip"
        class="inline-flex items-center gap-1 px-1.5 py-px rounded-md text-[10px] font-medium leading-tight"
        :class="[statusChip.bg, statusChip.text]"
      >
        <span class="size-1 rounded-full" :class="statusChip.dot" />
        {{ statusChip.label }}
      </span>
    </div>

    <div
      class="group/card relative flex flex-col gap-1 overflow-hidden"
      :class="[
        card ? 'rounded-xl border border-default bg-[var(--ui-bg-elevated)]/5 p-4 min-h-[5.5rem]' : '',
        to && card ? 'transition-colors hover:border-accented' : '',
        to && !card ? 'transition-opacity hover:opacity-80' : '',
      ]"
    >
      <!-- Ambient sparkline backdrop (card mode only) -->
      <div
        v-if="card && sparkline?.length && !isLoading"
        class="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 opacity-30 transition-opacity duration-200 group-hover/card:opacity-100"
        aria-hidden="true"
      >
        <ClientOnly>
          <UiSparkline
            :data="sparkline"
            width="100%"
            height="100%"
            preserve-aspect-ratio="none"
            :stroke-width="1"
            :colors="['var(--ui-text-dimmed)', 'var(--ui-text-muted)']"
          />
        </ClientOnly>
      </div>

      <!-- Hover affordance: chevron signals the card is clickable -->
      <UIcon
        v-if="to && card"
        name="i-lucide-chevron-right"
        class="pointer-events-none absolute top-2.5 right-2.5 size-3.5 text-dimmed opacity-0 -translate-x-1 transition-all duration-150 group-hover/card:opacity-100 group-hover/card:translate-x-0"
        aria-hidden="true"
      />

      <!-- Loading skeleton -->
      <template v-if="isLoading">
        <UiSkeleton :base="80" :index="0" />
      </template>

      <!-- Content -->
      <template v-else>
        <!-- Value + sparkline row (inline to reduce vertical weight) -->
        <div class="relative flex items-end justify-between gap-3">
          <slot>
            <div v-if="value != null" class="flex items-baseline gap-2 min-w-0">
              <span class="font-bold font-mono tabular-nums tracking-tight" :class="[sizeConfig.value, valueClass || 'text-default']">
                {{ displayValue }}
              </span>
              <span v-if="suffix" class="text-sm text-muted">{{ suffix }}</span>
              <slot v-if="card" name="trend">
                <span v-if="trend != null && trend !== 0" class="text-xs font-medium font-mono tabular-nums" :class="trendColorClass">
                  {{ formattedTrend }}
                </span>
                <span v-if="trendLabel" class="text-xs text-dimmed">{{ trendLabel }}</span>
              </slot>
            </div>
            <span v-else class="font-semibold text-muted" :class="sizeConfig.value">&mdash;</span>
          </slot>
          <div v-if="!card && sparkline?.length" class="shrink-0 -mb-0.5">
            <ClientOnly>
              <UiSparkline
                :data="sparkline"
                :size="size"
                :color="sparklineColor"
              />
            </ClientOnly>
          </div>
        </div>

        <!-- Info slot for extra content -->
        <slot name="info" />
      </template>
    </div>
  </component>
</template>
