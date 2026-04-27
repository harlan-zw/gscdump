<script setup lang="ts">
// Page header: breadcrumb + title + description + trailing actions slot.
// Extracted after six sibling pages converged on the same shape
// (overview, queries list, pages list, countries, indexing, sitemaps).

interface Crumb {
  label: string
  to?: string
}

const { crumbs = [], title, icon, description } = defineProps<{
  crumbs?: Crumb[]
  title: string
  icon?: string
  description?: string
}>()
</script>

<template>
  <header class="max-w-[1128px] px-4 sm:px-6 lg:px-9 border-b border-default pb-3">
    <div class="flex items-start gap-4 pt-5">
      <div class="flex flex-col sm:flex-row justify-between min-w-0 w-full gap-3 sm:gap-0">
        <div class="min-w-0">
          <div v-if="crumbs.length" class="flex items-center gap-2 text-xs text-dimmed mb-1">
            <template v-for="(crumb, i) in crumbs" :key="i">
              <NuxtLink v-if="crumb.to" :to="crumb.to" class="hover:text-default">
                {{ crumb.label }}
              </NuxtLink>
              <span v-else class="text-muted truncate max-w-[300px]">
                {{ crumb.label }}
              </span>
              <UIcon
                v-if="i < crumbs.length - 1"
                name="i-lucide-chevron-right"
                class="size-3"
              />
            </template>
          </div>
          <h1 class="text-xl font-semibold tracking-tight text-default flex items-center gap-2 min-w-0">
            <UIcon v-if="icon" :name="icon" class="size-4 text-dimmed shrink-0" />
            <span class="truncate">{{ title }}</span>
          </h1>
          <p v-if="description" class="text-[13px] text-muted mt-0.5 leading-snug">
            {{ description }}
          </p>
        </div>
        <div class="flex items-center gap-3 flex-wrap shrink-0">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </header>
</template>
