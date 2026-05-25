<script setup lang="ts">
withDefaults(defineProps<{
  icon: string
  title: string
  description?: string
  ctaHref?: string
  headlineClass?: string
}>(), {
  description: '',
  ctaHref: '',
  headlineClass: 'text-default',
})
</script>

<template>
  <article class="rounded-lg border border-default bg-default p-4 min-h-[150px]">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-dimmed uppercase tracking-widest">
          <UIcon :name="icon" class="size-3 shrink-0" />
          <span class="truncate">{{ title }}</span>
        </div>
        <p v-if="description" class="mt-1 text-xs text-muted leading-snug">
          {{ description }}
        </p>
      </div>
      <UButton
        v-if="ctaHref"
        :to="ctaHref"
        icon="i-lucide-arrow-up-right"
        variant="ghost"
        color="neutral"
        size="xs"
        :aria-label="`Open ${title} analyzer`"
      />
    </div>

    <div class="mt-5">
      <div class="text-2xl font-semibold tabular-nums tracking-tight" :class="headlineClass">
        <slot name="headline" />
      </div>
      <p class="mt-1 text-xs text-muted leading-snug">
        <slot name="tagline" />
      </p>
    </div>
  </article>
</template>
