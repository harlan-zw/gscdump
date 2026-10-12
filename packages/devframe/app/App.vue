<script setup lang="ts">
import type { GscdumpContext, PageLocation, PageStats, Period } from '../src/shared/protocol'
import type { Metric } from './format'
import type { PanelHost } from './host'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PERIODS } from '../src/shared/protocol'
import DailyChart from './components/DailyChart.vue'
import QueryTable from './components/QueryTable.vue'
import StatTile from './components/StatTile.vue'
import { formatDay, METRICS } from './format'

const { host } = defineProps<{ host: PanelHost }>()

// Per-viewer preferences. Storage can be blocked; the panel works without it.
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value == null)
      localStorage.removeItem(key)
    else
      localStorage.setItem(key, value)
  }
  catch {
    // Blocked storage only loses the preference for the next visit.
  }
}

const SITE_KEY = 'gscdump-devframe:site'
const PERIOD_KEY = 'gscdump-devframe:period'

const context = ref<GscdumpContext | null>(null)
const preferredSiteId = ref<string | null>(stored(SITE_KEY))
const storedPeriod = stored(PERIOD_KEY)
const period = ref<Period>(PERIODS.some(p => p.value === storedPeriod) ? storedPeriod as Period : '28d')
const metric = ref<Metric>('clicks')

/** The page in view, from the host. `null` when the host cannot see one. */
const hostLocation = ref<PageLocation | null>(null)
/** The first read waits briefly for the page in view, so it does not read `/` first. */
const pageReady = ref(!host.followPage)
const follow = ref(!!host.followPage)
const pageInput = ref('/')
const page = ref('/')

const stats = ref<PageStats | null>(null)
const loading = ref(false)
let request = 0

const periodOption = computed(() => PERIODS.find(p => p.value === period.value) ?? PERIODS[1]!)
const windowLabel = computed(() => periodOption.value.label)
const previousLabel = computed(() => `previous ${periodOption.value.days} days`)
const site = computed(() => context.value?._tag === 'Ready' ? context.value.site : null)
const sites = computed(() => context.value?._tag === 'Ready' || context.value?._tag === 'SiteRequired' ? context.value.sites : [])
/** The host of the page in view. A new host can mean a new Site. */
const pageHost = computed(() => hostLocation.value ? URL.parse(hostLocation.value.href)?.host ?? null : null)

async function loadContext(): Promise<void> {
  context.value = null
  context.value = await host.context(preferredSiteId.value, hostLocation.value?.href ?? null)
}

async function loadStats(): Promise<void> {
  const current = site.value
  if (!current || !pageReady.value)
    return
  const id = ++request
  loading.value = true
  const result = await host.pageStats({ page: page.value, period: period.value, siteId: current.siteId })
  if (id !== request)
    return
  stats.value = result
  loading.value = false
}

function selectSite(siteId: string): void {
  preferredSiteId.value = siteId
  store(SITE_KEY, siteId)
  void loadContext()
}

function showPage(): void {
  const next = pageInput.value.trim() || '/'
  pageInput.value = next
  follow.value = hostLocation.value?.path === next
  page.value = next
}

function followPage(): void {
  follow.value = true
  if (hostLocation.value) {
    pageInput.value = hostLocation.value.path
    page.value = hostLocation.value.path
  }
}

watch(period, value => store(PERIOD_KEY, value))
watch([pageReady, pageHost], () => {
  if (pageReady.value)
    void loadContext()
}, { immediate: true })
watch([page, period, site, pageReady], () => void loadStats())
watch(hostLocation, (location) => {
  if (location && follow.value) {
    pageInput.value = location.path
    page.value = location.path
  }
})

let stopFollowing: (() => void) | null = null

onMounted(() => {
  if (!host.followPage)
    return
  setTimeout(() => {
    pageReady.value = true
  }, 2000)
  stopFollowing = host.followPage((location) => {
    hostLocation.value = location
    pageReady.value = true
  })
})

onBeforeUnmount(() => stopFollowing?.())

const okStats = computed(() => stats.value?._tag === 'Ok' ? stats.value : null)
const empty = computed(() => okStats.value?.totals.impressions === 0)
const dateRange = computed(() => okStats.value ? `${formatDay(okStats.value.window.start, true)} to ${formatDay(okStats.value.window.end, true)}` : '')
</script>

<template>
  <main class="panel">
    <header class="header">
      <div class="brand">
        <strong>Search Console</strong>
        <span class="muted">gscdump</span>
      </div>
      <div class="controls">
        <label v-if="sites.length > 1 && context?._tag === 'Ready' && !context.configured" class="field">
          <span class="sr-only">Site</span>
          <select class="control" :value="site?.siteId" @change="selectSite(($event.target as HTMLSelectElement).value)">
            <option v-for="option in sites" :key="option.siteId" :value="option.siteId">{{ option.siteUrl }} ({{ option.siteId }})</option>
          </select>
        </label>
        <span v-else-if="site" class="site mono">{{ site.siteUrl }}</span>
        <label class="field">
          <span class="sr-only">Window</span>
          <select v-model="period" class="control">
            <option v-for="option in PERIODS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
      </div>
    </header>

    <p v-if="!context" class="notice muted">
      Connecting to gscdump
    </p>

    <section v-else-if="context._tag === 'CredentialMissing'" class="notice">
      <strong>Connect gscdump</strong>
      <p>This devtool reads Search Console data from your gscdump Hosted record. Do one of these, then select Try again:</p>
      <ul>
        <li>Run <code class="mono">gscdump auth login --mode hosted</code>.</li>
        <li>Set <code class="mono">GSCDUMP_API_KEY</code> to a user API key from gscdump.com, then restart the dev server.</li>
      </ul>
      <button type="button" class="button" @click="loadContext">
        Try again
      </button>
    </section>

    <section v-else-if="context._tag === 'CredentialRejected'" class="notice error">
      <strong>gscdump did not accept the credential</strong>
      <p v-if="context.source === 'cli-session'">
        The CLI login expired or was revoked. Run <code class="mono">gscdump auth login --mode hosted</code>, then select Try again.
      </p>
      <p v-else>
        Create a new user API key at gscdump.com and set it as <code class="mono">GSCDUMP_API_KEY</code>.
      </p>
      <button type="button" class="button" @click="loadContext">
        Try again
      </button>
    </section>

    <section v-else-if="context._tag === 'SignedOut'" class="notice">
      <strong>Sign in to gscdump.com</strong>
      <p>This panel reads your Sites with your gscdump.com login. Sign in, then select Try again.</p>
      <div class="actions">
        <a class="button" :href="context.signInUrl" target="_blank" rel="noopener">Sign in</a>
        <button type="button" class="button" @click="loadContext">
          Try again
        </button>
      </div>
    </section>

    <section v-else-if="context._tag === 'NoSiteForPage'" class="notice">
      <strong>No Site for {{ context.host }}</strong>
      <p>None of your gscdump Sites covers <code class="mono">{{ context.host }}</code>. Open a page on one of your Sites, or add this one at <a href="https://gscdump.com/app/onboarding?step=connect-sites" target="_blank" rel="noopener">gscdump.com</a>.</p>
    </section>

    <section v-else-if="context._tag === 'NoSites'" class="notice">
      <strong>No Sites yet</strong>
      <p>Your gscdump account has no Sites. Connect a Site at <a href="https://gscdump.com/app/onboarding?step=connect-sites" target="_blank" rel="noopener">gscdump.com</a>, then select Try again.</p>
      <button type="button" class="button" @click="loadContext">
        Try again
      </button>
    </section>

    <section v-else-if="context._tag === 'Unavailable'" class="notice error">
      <strong>gscdump is not available</strong>
      <p>{{ context.message }}</p>
      <button type="button" class="button" @click="loadContext">
        Try again
      </button>
    </section>

    <section v-else-if="context._tag === 'SiteRequired'" class="notice">
      <strong>Select a Site</strong>
      <p v-if="context.target">
        No single Site matches "{{ context.target }}". Select one.
      </p>
      <div class="site-list">
        <button v-for="option in context.sites" :key="option.siteId" type="button" class="button" @click="selectSite(option.siteId)">
          {{ option.siteUrl }} <span class="muted mono">{{ option.siteId }}</span>
        </button>
      </div>
    </section>

    <template v-else>
      <form class="page-bar" @submit.prevent="showPage">
        <label class="page-field">
          <span class="sr-only">Page path or URL</span>
          <input v-model="pageInput" class="control mono" type="text" placeholder="/blog/post" spellcheck="false" autocomplete="off">
        </label>
        <button type="submit" class="button">
          Show
        </button>
        <button
          type="button"
          class="button"
          :aria-pressed="follow"
          :disabled="!hostLocation"
          :title="hostLocation ? 'Show the page in view' : 'This panel cannot see a page here'"
          @click="followPage"
        >
          {{ host.followLabel }}
        </button>
      </form>

      <p v-if="!stats" class="notice muted">
        Reading Search Console data for {{ page }}
      </p>

      <section v-else-if="stats._tag === 'InvalidPage'" class="notice error">
        Type a path, such as /blog/post, or a full URL.
      </section>

      <section v-else-if="stats._tag === 'NoData'" class="notice">
        {{ stats.message }}
      </section>

      <section v-else-if="stats._tag === 'RateLimited'" class="notice error">
        gscdump limits page reads per minute. Try again in a minute.
      </section>

      <section v-else-if="stats._tag === 'SiteUnavailable'" class="notice error">
        The Site is not available. <button type="button" class="link-button" @click="loadContext">
          Check the connection
        </button>
      </section>

      <section v-else-if="stats._tag === 'Failed'" class="notice error">
        The read failed: {{ stats.message }}
        <span v-if="stats.requestId" class="muted mono">Request {{ stats.requestId }}</span>
      </section>

      <div v-else-if="okStats" class="report" :class="{ loading }" :aria-busy="loading">
        <div class="tiles">
          <StatTile
            v-for="option in METRICS"
            :key="option.key"
            :metric="option.key"
            :label="option.label"
            :totals="okStats.totals"
            :previous-totals="okStats.previousTotals"
            :previous-label="previousLabel"
            :selected="metric === option.key"
            @select="metric = $event"
          />
        </div>

        <p v-if="empty" class="notice">
          Google shows no impressions for <code class="mono">{{ okStats.path }}</code> in this window.
          Search Console stores each URL exactly, so check the trailing slash.
        </p>

        <div v-else class="card block">
          <DailyChart
            :daily="okStats.daily"
            :previous-daily="okStats.previousDaily"
            :metric="metric"
            :window-label="windowLabel"
            :previous-label="`Previous ${periodOption.days} days`"
          />
        </div>

        <div v-if="okStats.queries.length" class="card block">
          <h2 class="section-title">
            Top queries
          </h2>
          <QueryTable :queries="okStats.queries" />
        </div>

        <footer class="footer">
          <span class="muted">{{ dateRange }}</span>
          <a :href="okStats.dashboardUrl" target="_blank" rel="noopener">Open in gscdump</a>
        </footer>
      </div>
    </template>
  </main>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1100px;
  margin: 0 auto;
  padding: 14px 16px 24px;
}

.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.site {
  color: var(--muted);
  font-size: 13px;
}

.page-bar {
  display: flex;
  gap: 8px;
}

.page-field {
  flex: 1;
  min-width: 0;
}

.page-field input {
  width: 100%;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.notice {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.notice p {
  margin: 6px 0;
}

.notice ul {
  margin: 6px 0 10px;
  padding-left: 18px;
}

.notice.error {
  border-color: color-mix(in srgb, var(--bad) 40%, var(--border));
}

.actions {
  display: flex;
  gap: 8px;
}

.site-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--link);
  text-decoration: underline;
  cursor: pointer;
}

.report {
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: opacity 120ms ease;
}

.report.loading {
  opacity: 0.6;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
}

.block {
  padding: 12px;
}

.section-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
</style>
