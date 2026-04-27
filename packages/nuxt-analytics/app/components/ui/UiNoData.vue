<script setup lang="ts">
// Minimal "no data" state. Trimmed from nuxtseo/core — drops UiBox container
// variants and the preset action list (refresh/reset/clear/back); keeps
// { icon, title, message } + default / title / action / footer slots.

const {
  icon = 'i-lucide-folder',
  title = 'No data',
  message = 'There is no data to display',
} = defineProps<{
  icon?: string
  title?: string
  message?: string
}>()

defineSlots<{
  title: () => void
  default: () => void
  action: () => void
  footer: () => void
}>()
</script>

<template>
  <div data-ui="UiNoData" class="w-full h-full">
    <div class="flex grow items-center justify-center min-h-60">
      <div class="text-center leading-none">
        <UIcon :name="icon" class="size-8 text-muted" />

        <div class="font-bold text-default text-base mt-3">
          <slot name="title">
            {{ title }}
          </slot>
        </div>

        <div v-if="$slots.default || message" class="text-sm text-muted">
          <slot>
            <span v-html="message.trim().replaceAll(/[\n\r]+/g, '<br>')" />
          </slot>
        </div>

        <div v-if="$slots.action" class="mt-3">
          <slot name="action" />
        </div>
      </div>
    </div>

    <div v-if="$slots.footer" class="text-sm text-center grow-0">
      <slot name="footer" />
    </div>
  </div>
</template>
