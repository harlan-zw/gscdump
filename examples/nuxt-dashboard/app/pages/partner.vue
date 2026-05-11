<script setup lang="ts">
import type { GscdumpUserSite } from '@gscdump/sdk'

interface PartnerSitesResponse {
  configured: boolean
  apiBase?: string
  message?: string
  sites: GscdumpUserSite[]
}

const { data, status, error, refresh } = await useFetch<PartnerSitesResponse>('/api/partner/sites')

const sites = computed(() => data.value?.sites ?? [])

function fmtDate(v: string | null | undefined): string {
  return v || '-'
}
</script>

<template>
  <main class="min-h-screen">
    <header class="border-b border-default">
      <div class="max-w-[1128px] px-4 sm:px-6 lg:px-9 py-5">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 class="text-xl font-semibold tracking-tight text-default">
              Partner API
            </h1>
            <p class="text-[13px] text-muted mt-0.5">
              Prototype consumer for <code>@gscdump/sdk</code>.
            </p>
          </div>
          <UButton icon="i-lucide-refresh-cw" variant="soft" size="sm" :loading="status === 'pending'" @click="refresh()">
            Refresh
          </UButton>
        </div>
      </div>
    </header>

    <section class="max-w-[1128px] px-4 sm:px-6 lg:px-9 py-6 space-y-5">
      <UAlert
        v-if="!data?.configured"
        color="neutral"
        variant="soft"
        icon="i-lucide-key-round"
        title="Partner credentials not configured"
        :description="data?.message"
      />

      <UAlert
        v-else
        color="success"
        variant="soft"
        icon="i-lucide-plug"
        title="Partner client configured"
        :description="`Using ${data.apiBase}`"
      />

      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        icon="i-lucide-alert-triangle"
        title="Partner request failed"
        :description="error.message"
      />

      <div class="border border-default rounded-lg overflow-hidden">
        <div class="px-4 py-3 border-b border-default flex items-center justify-between gap-3">
          <h2 class="text-sm font-medium text-default">
            User Sites
          </h2>
          <span class="text-xs text-muted">{{ sites.length }} sites</span>
        </div>

        <div v-if="status === 'pending'" class="p-4 space-y-2">
          <USkeleton class="h-8 w-full" />
          <USkeleton class="h-8 w-full" />
          <USkeleton class="h-8 w-2/3" />
        </div>

        <div v-else-if="!sites.length" class="p-8 text-center text-sm text-muted">
          No Partner sites returned.
        </div>

        <div v-else class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead class="bg-muted/30 text-xs text-muted">
              <tr>
                <th class="text-left font-medium px-4 py-2">
                  Site
                </th>
                <th class="text-left font-medium px-4 py-2">
                  Sync
                </th>
                <th class="text-left font-medium px-4 py-2">
                  Indexing
                </th>
                <th class="text-left font-medium px-4 py-2">
                  Newest Data
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="site in sites" :key="site.siteId" class="border-t border-default">
                <td class="px-4 py-2">
                  <div class="font-medium text-default">
                    {{ site.siteUrl }}
                  </div>
                  <div class="text-xs text-muted font-mono">
                    {{ site.siteId }}
                  </div>
                </td>
                <td class="px-4 py-2 text-muted">
                  {{ site.syncStatus }}
                </td>
                <td class="px-4 py-2 text-muted">
                  {{ site.indexingStatus ?? '-' }}
                </td>
                <td class="px-4 py-2 text-muted">
                  {{ fmtDate(site.newestDateSynced) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </main>
</template>
