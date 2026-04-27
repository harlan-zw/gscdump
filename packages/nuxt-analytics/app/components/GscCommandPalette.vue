<script setup lang="ts">
// Cmd+K palette. Wraps UCommandPalette inside a UModal, wires up the global
// keyboard shortcut, and sources its items from the analytics context + a
// static list of top-level routes. Drop `<GscCommandPalette />` into your
// root layout once.
//
// Hosts can extend the groups via the `groups` prop — e.g. nuxtseo.com adds
// its billing / settings entries without forking the component.

import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { SiteListItem } from '../composables/useGscAnalytics'
import { useMagicKeys, whenever } from '@vueuse/core'
import { useGscSites } from '../composables/useGscAnalytics'

const { groups: extraGroups = [] } = defineProps<{
  groups?: CommandPaletteGroup[]
}>()

const router = useRouter()
const { sites } = useGscSites()

const open = ref(false)
const selected = ref<CommandPaletteItem | null>(null)

const keys = useMagicKeys()
const cmdK = computed(() => keys.meta_k?.value || keys.ctrl_k?.value || false)
whenever(cmdK, () => {
  open.value = !open.value
})

const siteGroup = computed<CommandPaletteGroup<CommandPaletteItem>>(() => ({
  id: 'sites',
  label: 'Sites',
  items: (sites.value ?? []).map<CommandPaletteItem>((s: SiteListItem) => ({
    label: s.hostname,
    suffix: s.propertyType === 'domain' ? 'sc-domain' : 'url-prefix',
    icon: 'i-lucide-globe',
    to: `/sites/${encodeURIComponent(s.id)}`,
  })),
}))

const navGroup: CommandPaletteGroup<CommandPaletteItem> = {
  id: 'nav',
  label: 'Navigation',
  items: [
    { label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' },
  ],
}

const allGroups = computed<CommandPaletteGroup[]>(() => [
  siteGroup.value,
  navGroup,
  ...extraGroups,
])

watch(selected, (item) => {
  if (!item)
    return
  if (typeof item.to === 'string')
    router.push(item.to)
  open.value = false
  selected.value = null
})
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-[560px]' }">
    <template #content>
      <UCommandPalette
        v-model="selected"
        :groups="allGroups"
        placeholder="Jump to a site or action…"
        class="h-[420px]"
      />
    </template>
  </UModal>
</template>
