<script setup lang="ts">
// Demo-only toggle. Flips the `gscdump-tier` cookie and reloads so every
// SSR/server-routed endpoint (auth provider, source provider, source-info)
// resolves under the new tier. Not part of the layer — real deploys pick
// tier from the user's plan record.

const cookie = useCookie<'free' | 'pro'>('gscdump-tier', {
  default: () => 'pro',
  sameSite: 'lax',
  path: '/',
})

function set(tier: 'free' | 'pro') {
  if (cookie.value === tier)
    return
  cookie.value = tier
  if (import.meta.client)
    window.location.reload()
}
</script>

<template>
  <div class="rounded-md border border-default p-1 flex gap-0.5 text-[11px] font-medium">
    <button
      type="button"
      class="px-2 py-1 rounded transition-colors"
      :class="cookie === 'free' ? 'bg-elevated text-highlighted' : 'text-muted hover:text-default'"
      @click="set('free')"
    >
      Free
    </button>
    <button
      type="button"
      class="px-2 py-1 rounded transition-colors inline-flex items-center gap-1"
      :class="cookie === 'pro' ? 'bg-primary text-inverted' : 'text-muted hover:text-default'"
      @click="set('pro')"
    >
      <UIcon name="i-lucide-sparkles" class="size-3" />
      Pro
    </button>
  </div>
</template>
