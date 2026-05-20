<script setup lang="ts">
import { useIntersectionObserver } from '@vueuse/core'
import { useGscFetch } from '../utils/gsc-fetch'

const props = defineProps<{
  siteUrl: string
  type: 'topPage' | 'topKeyword'
  identifier: string
  startDate: string
  endDate: string
}>()

const container = useTemplateRef<HTMLElement>('container')
const value = ref<string | null>(null)
const loaded = ref(false)

const { stop } = useIntersectionObserver(
  container,
  ([entry]) => {
    if (!entry?.isIntersecting || loaded.value)
      return
    loaded.value = true
    stop()
    useGscFetch()<{ value: string | null }>(`/api/__gsc/sites/${encodeURIComponent(props.siteUrl)}/data/top-association`, {
      query: {
        type: props.type,
        identifier: props.identifier,
        startDate: props.startDate,
        endDate: props.endDate,
      },
    })
      .then(r => value.value = r.value)
      .catch(() => {})
  },
  { rootMargin: '100px' },
)
</script>

<template>
  <div ref="container">
    <div v-if="value" class="text-xs text-muted truncate max-w-md">
      {{ value }}
    </div>
  </div>
</template>
