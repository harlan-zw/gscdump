<script setup lang="ts">
interface Crumb {
  label: string
  to?: string
}

defineProps<{
  crumbs?: Crumb[]
  title: string
  icon?: string
  description?: string
}>()
</script>

<template>
  <header class="max-w-[1128px] px-4 sm:px-6 lg:px-9 border-b border-default pb-3">
    <div class="pt-4">
      <nav v-if="crumbs?.length" class="mb-2 flex items-center gap-1.5 text-[12px] text-muted">
        <template v-for="(crumb, index) in crumbs" :key="`${crumb.label}-${index}`">
          <NuxtLink
            v-if="crumb.to"
            :to="crumb.to"
            class="hover:text-default"
          >
            {{ crumb.label }}
          </NuxtLink>
          <span v-else class="text-dimmed">{{ crumb.label }}</span>
          <UIcon
            v-if="index < crumbs.length - 1"
            name="i-lucide-chevron-right"
            class="size-3 text-dimmed"
          />
        </template>
      </nav>

      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <slot name="icon">
              <UIcon v-if="icon" :name="icon" class="size-4 text-dimmed shrink-0" />
            </slot>
            <h1 class="truncate text-xl font-semibold tracking-tight text-default">
              {{ title }}
            </h1>
          </div>
          <p v-if="description" class="text-[13px] text-muted mt-0.5 leading-snug">
            {{ description }}
          </p>
        </div>
        <div v-if="$slots.actions" class="flex items-center gap-2 flex-wrap justify-end">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </header>
</template>
