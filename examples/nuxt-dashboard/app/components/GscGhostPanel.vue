<script setup lang="ts">
// Renders a "locked" overlay over its default slot when the server-resolved
// AnalysisQuerySource can't satisfy the requested analyzer (or when the slot
// is explicitly declared as requiring SQL capability the source lacks).
//
// Tier logic lives in the example app, not the layer: we just consume
// source-info and render lock UI based on what the source advertises.

// useGscAnalyticsSourceInfo is auto-imported from the layer's composables.

const props = defineProps<{
  siteId: string
  /** Gate by analyzer id — lock when source can't run this analyzer. */
  analyzerId?: string
  /** Gate by source kind — lock when the source isn't SQL-capable. */
  requires?: 'sql' | 'row'
  /** Headline shown over the ghost. */
  title?: string
  /** Supporting copy under the headline. */
  description?: string
  /** Label on the primary CTA. */
  ctaLabel?: string
  /** Where the CTA points. */
  ctaHref?: string
}>()

const { info, loading } = useGscAnalyticsSourceInfo(() => props.siteId)

const locked = computed(() => {
  if (loading.value)
    return false
  if (!info.value)
    return true
  if (props.requires === 'sql' && info.value.kind !== 'sql')
    return true
  if (props.analyzerId && !info.value.supportedAnalyzerIds.includes(props.analyzerId))
    return true
  return false
})
</script>

<template>
  <div class="relative">
    <div :class="locked ? 'pointer-events-none select-none blur-sm opacity-60' : ''">
      <slot />
    </div>

    <div
      v-if="locked"
      class="absolute inset-0 flex items-center justify-center p-4"
    >
      <div class="w-full max-w-sm rounded-lg border border-default bg-default/95 backdrop-blur shadow-lg p-5 text-center">
        <div class="inline-flex items-center justify-center size-9 rounded-full bg-primary/10 text-primary mb-3">
          <UIcon name="i-lucide-lock" class="size-4" />
        </div>
        <div class="text-sm font-semibold text-highlighted">
          {{ title ?? 'Upgrade to unlock' }}
        </div>
        <p v-if="description" class="text-xs text-muted mt-1 leading-snug">
          {{ description }}
        </p>
        <UButton
          v-if="ctaHref"
          :to="ctaHref"
          size="xs"
          color="primary"
          class="mt-3"
        >
          {{ ctaLabel ?? 'Upgrade' }}
        </UButton>
      </div>
    </div>
  </div>
</template>
