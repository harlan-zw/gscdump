<script setup lang="ts">
const props = defineProps<{
  range?: { start: string, end: string } | null
  runner?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[], queryMs: number }> }
  ready?: boolean
  seed?: string
  title?: string
  limit?: number
}>()

const injected = props.runner ? null : useGscPanelRunner()
const runner = computed(() => props.runner ?? injected?.runner)
const ready = computed(() => props.ready ?? injected?.ready.value ?? false)
const repo = useSemanticKeywordRepo()
const activeBucketId = ref<string | null>(null)

const nf = new Intl.NumberFormat()
const pf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

const rangeLabel = computed(() => props.range ? `${props.range.start} to ${props.range.end}` : 'current range')
const visibleHits = computed(() => {
  const seed = (props.seed ?? '').trim().toLowerCase()
  return repo.hits.value.filter(hit => hit.query.toLowerCase() !== seed).slice(0, props.limit ?? 12)
})
const activeBucket = computed(() => repo.buckets.value.find(bucket => bucket.id === activeBucketId.value) ?? repo.buckets.value[0] ?? null)

watch(
  ready,
  (value) => {
    if (value && runner.value && repo.rows.value.length === 0)
      void repo.build(runner.value)
  },
  { immediate: true },
)

watch(
  () => props.seed,
  (seed) => {
    if (seed && seed !== repo.topic.value)
      void repo.search(seed)
  },
  { immediate: true },
)

function runSearch(): void {
  void repo.search()
}

function useSeed(query: string): void {
  void repo.search(query)
}

function selectBucket(id: string, seedQuery: string): void {
  activeBucketId.value = id
  void repo.search(seedQuery)
}
</script>

<template>
  <div class="semantic-repo">
    <div class="semantic-toolbar">
      <div class="semantic-search">
        <label for="semantic-topic">Topic</label>
        <input
          id="semantic-topic"
          v-model="repo.topic.value"
          type="search"
          placeholder="search console api"
          :disabled="repo.loading.value"
          @keydown.enter.prevent="runSearch"
        >
      </div>
      <button :disabled="!ready || !runner || repo.loading.value" @click="runner && repo.build(runner)">
        {{ repo.loading.value ? 'Building...' : repo.rows.value.length > 0 ? 'Rebuild repo' : 'Build repo' }}
      </button>
      <button :disabled="!ready || repo.loading.value || repo.rows.value.length === 0" @click="runSearch">
        Search
      </button>
    </div>

    <div v-if="repo.error.value" class="semantic-error">
      {{ repo.error.value.message }}
    </div>

    <div v-if="repo.stats.value" class="semantic-stats">
      <div>
        <span>keywords</span>
        <strong>{{ nf.format(repo.stats.value.keywords) }}</strong>
      </div>
      <div>
        <span>embedding batches</span>
        <strong>{{ nf.format(repo.stats.value.batches) }}</strong>
      </div>
      <div>
        <span>vector dims</span>
        <strong>{{ repo.stats.value.dimensions }}</strong>
      </div>
      <div>
        <span>range</span>
        <strong>{{ rangeLabel }}</strong>
      </div>
    </div>

    <div v-if="repo.loading.value" class="semantic-state">
      Reading top queries, embedding in batches, then searching the in-memory vector index.
    </div>

    <div v-if="!repo.loading.value && repo.buckets.value.length > 0" class="semantic-buckets">
      <div class="bucket-header">
        <h3>Topic buckets</h3>
        <span>{{ repo.buckets.value.length }} groups from the same embedding index</span>
      </div>
      <div class="bucket-grid">
        <button
          v-for="bucket in repo.buckets.value"
          :key="bucket.id"
          type="button"
          class="bucket"
          :class="{ active: activeBucket?.id === bucket.id }"
          @click="selectBucket(bucket.id, bucket.seedQuery)"
        >
          <span class="bucket-name">{{ bucket.label }}</span>
          <span class="bucket-meta">
            {{ nf.format(bucket.keywords) }} keywords · {{ nf.format(Math.round(bucket.clicks)) }} clicks · {{ nf.format(Math.round(bucket.impressions)) }} impr.
          </span>
        </button>
      </div>

      <div v-if="activeBucket" class="bucket-members">
        <div class="bucket-members-head">
          <strong>{{ activeBucket.label }}</strong>
          <span>seed: {{ activeBucket.seedQuery }}</span>
        </div>
        <div class="member-list">
          <button
            v-for="member in activeBucket.members.slice(0, 10)"
            :key="member.id"
            type="button"
            class="member"
            @click="useSeed(member.query)"
          >
            <span>{{ member.query }}</span>
            <span>{{ pf.format(member.similarity * 100) }}%</span>
          </button>
        </div>
      </div>
    </div>

    <h3 v-if="title" class="semantic-title">
      {{ title }}
    </h3>

    <div v-if="!repo.loading.value && visibleHits.length > 0" class="semantic-results">
      <table>
        <thead>
          <tr>
            <th>similarity</th>
            <th>query</th>
            <th>clicks</th>
            <th>impr.</th>
            <th>pos.</th>
            <th>top URL</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="hit in visibleHits" :key="hit.id">
            <td class="num">
              {{ pf.format(hit.similarity * 100) }}%
            </td>
            <td>
              <button class="query-button" :title="hit.query" @click="useSeed(hit.query)">
                {{ hit.query }}
              </button>
              <div v-if="hit.canonical !== hit.query" class="canonical">
                {{ hit.canonical }}
              </div>
            </td>
            <td class="num">
              {{ nf.format(Math.round(hit.clicks)) }}
            </td>
            <td class="num">
              {{ nf.format(Math.round(hit.impressions)) }}
            </td>
            <td class="num">
              {{ hit.position ? hit.position.toFixed(1) : '-' }}
            </td>
            <td>
              <span v-if="hit.topUrl" class="url" :title="hit.topUrl">{{ hit.topUrl }}</span>
              <span v-else class="muted">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="!repo.loading.value" class="semantic-state">
      Build the repo to see vector hits rejoined to site metrics.
    </div>
  </div>
</template>

<style scoped>
.semantic-repo { display: flex; flex-direction: column; gap: 0.85rem; }
.semantic-toolbar { display: flex; align-items: end; gap: 0.55rem; flex-wrap: wrap; }
.semantic-search { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.28rem; }
.semantic-search label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: #777; font-weight: 700; }
.semantic-search input { width: 100%; min-height: 2.25rem; border: 1px solid #dedee7; border-radius: 4px; padding: 0.45rem 0.6rem; font-size: 0.88rem; color: #202025; background: #fff; }
.semantic-toolbar button { min-height: 2.25rem; border: 1px solid #d9d9e4; border-radius: 4px; padding: 0 0.8rem; background: #fff; color: #24242a; font-size: 0.82rem; font-weight: 650; cursor: pointer; }
.semantic-toolbar button:last-child { background: #214f4b; border-color: #214f4b; color: #fff; }
.semantic-toolbar button:disabled { opacity: 0.45; cursor: not-allowed; }
.semantic-error { padding: 0.85rem 1rem; color: #b42318; background: #fff4f2; border: 1px solid #ffd8d2; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.78rem; }
.semantic-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid #ededf2; border-radius: 6px; overflow: hidden; background: #fbfbfd; }
.semantic-stats div { min-width: 0; padding: 0.7rem 0.85rem; border-right: 1px solid #ededf2; }
.semantic-stats div:last-child { border-right: 0; }
.semantic-stats span { display: block; margin-bottom: 0.18rem; color: #777; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
.semantic-stats strong { display: block; color: #202025; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.semantic-state { padding: 2rem 1rem; text-align: center; color: #666; background: #fafafb; border: 1px dashed #dedee7; border-radius: 6px; font-size: 0.86rem; }
.semantic-title { margin: 0.25rem 0 -0.25rem; color: #202025; font-size: 0.95rem; font-weight: 700; letter-spacing: 0; }
.semantic-buckets { display: flex; flex-direction: column; gap: 0.7rem; }
.bucket-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.bucket-header h3 { margin: 0; color: #202025; font-size: 0.95rem; font-weight: 700; letter-spacing: 0; }
.bucket-header span { color: #777; font-size: 0.76rem; }
.bucket-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }
.bucket { min-width: 0; border: 1px solid #ededf2; border-radius: 6px; padding: 0.65rem 0.75rem; background: #fff; text-align: left; cursor: pointer; }
.bucket:hover, .bucket.active { border-color: #8db7b2; background: #f5fbfa; }
.bucket-name { display: block; color: #202025; font-size: 0.86rem; font-weight: 750; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bucket-meta { display: block; margin-top: 0.18rem; color: #777; font-size: 0.72rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bucket-members { border: 1px solid #ededf2; border-radius: 6px; overflow: hidden; background: #fbfbfd; }
.bucket-members-head { display: flex; justify-content: space-between; gap: 1rem; padding: 0.55rem 0.7rem; border-bottom: 1px solid #ededf2; color: #202025; font-size: 0.82rem; }
.bucket-members-head span { min-width: 0; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.member-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.member { min-width: 0; display: flex; justify-content: space-between; gap: 0.8rem; border: 0; border-right: 1px solid #ededf2; border-bottom: 1px solid #ededf2; padding: 0.46rem 0.7rem; background: transparent; color: #444; font: inherit; font-size: 0.78rem; text-align: left; cursor: pointer; }
.member:nth-child(2n) { border-right: 0; }
.member:hover { background: #fff; color: #214f4b; }
.member span:first-child { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.member span:last-child { color: #777; font-variant-numeric: tabular-nums; white-space: nowrap; }
.semantic-results { overflow-x: auto; border: 1px solid #ededf2; border-radius: 6px; }
.semantic-results table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
.semantic-results th, .semantic-results td { padding: 0.52rem 0.7rem; border-bottom: 1px solid #ededf2; text-align: left; vertical-align: top; }
.semantic-results th { background: #f8f8fb; color: #777; font-size: 0.66rem; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.semantic-results tbody tr:last-child td { border-bottom: 0; }
.semantic-results tbody tr:hover { background: #fcfcfd; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.query-button { display: block; max-width: 320px; border: 0; padding: 0; background: transparent; color: #214f4b; font: inherit; font-weight: 650; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.query-button:hover { text-decoration: underline; }
.canonical { max-width: 320px; margin-top: 0.12rem; color: #888; font-size: 0.72rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.url { display: block; max-width: 360px; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.muted { color: #aaa; }

@media (max-width: 820px) {
  .semantic-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .semantic-stats div:nth-child(2) { border-right: 0; }
  .semantic-stats div:nth-child(-n+2) { border-bottom: 1px solid #ededf2; }
  .bucket-grid { grid-template-columns: 1fr; }
  .member-list { grid-template-columns: 1fr; }
  .member { border-right: 0; }
  .bucket-members-head { flex-direction: column; gap: 0.2rem; }
}
</style>
