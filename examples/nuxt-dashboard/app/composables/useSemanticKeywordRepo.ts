import type { Document, SearchProvider, SearchResult } from 'retriv'
import { createRetriv } from 'retriv'

interface AnalysisRunner {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[], queryMs: number }>
}

export interface SemanticKeywordRow {
  id: string
  query: string
  canonical: string
  clicks: number
  impressions: number
  position: number
  topUrl: string | null
  vector: Float32Array
}

export interface SemanticKeywordHit {
  id: string
  query: string
  canonical: string
  similarity: number
  clicks: number
  impressions: number
  position: number
  topUrl: string | null
}

export interface SemanticKeywordBucket {
  id: string
  label: string
  seedQuery: string
  keywords: number
  clicks: number
  impressions: number
  position: number
  topUrl: string | null
  members: SemanticKeywordHit[]
}

export interface SemanticRepoStats {
  keywords: number
  dimensions: number
  batches: number
  queryMs: number
}

export interface SemanticRepoRunner {
  rows: Ref<SemanticKeywordRow[]>
  hits: Ref<SemanticKeywordHit[]>
  buckets: Ref<SemanticKeywordBucket[]>
  topic: Ref<string>
  loading: Ref<boolean>
  searching: Ref<boolean>
  error: Ref<Error | null>
  stats: Ref<SemanticRepoStats | null>
  provider: Ref<SearchProvider | null>
  build: (runner: AnalysisRunner, opts?: { limit?: number }) => Promise<void>
  search: (topic?: string) => Promise<void>
  bucket: (opts?: { maxBuckets?: number, minSimilarity?: number, maxMembers?: number }) => void
}

const DIMENSIONS = 64
const EMBED_BATCH_SIZE = 100
const DEFAULT_BUCKETS = 12
const DEFAULT_BUCKET_SIMILARITY = 0.42
const DEFAULT_BUCKET_MEMBERS = 18

function normalizeKeyword(input: string): string {
  return input.toLowerCase().trim().replace(/\s+/g, ' ')
}

function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function keywordId(keyword: string): string {
  return `kw_${hashString(normalizeKeyword(keyword)).toString(16).padStart(8, '0')}`
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const h = hashString(feature)
  const index = h % vector.length
  const sign = (h & 1) === 0 ? 1 : -1
  vector[index] = (vector[index] ?? 0) + sign * weight
}

function embedText(text: string): Float32Array {
  const normalized = normalizeKeyword(text)
  const vector = new Float32Array(DIMENSIONS)
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean)

  for (const token of tokens) {
    addFeature(vector, `tok:${token}`, 1)
    for (let i = 0; i < token.length - 2; i++)
      addFeature(vector, `tri:${token.slice(i, i + 3)}`, 0.35)
  }

  for (let i = 0; i < tokens.length - 1; i++)
    addFeature(vector, `bi:${tokens[i]} ${tokens[i + 1]}`, 0.8)

  let norm = 0
  for (const v of vector)
    norm += v * v
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++)
      vector[i] = (vector[i] ?? 0) / norm
  }
  return vector
}

function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++)
    sum += a[i]! * b[i]!
  return sum
}

function createLocalKeywordProvider(indexRows: SemanticKeywordRow[]): SearchProvider {
  const docs = new Map<string, Document>()
  const vectors = new Map<string, Float32Array>()

  for (const row of indexRows) {
    docs.set(row.id, {
      id: row.id,
      content: row.canonical || row.query,
      metadata: {
        query: row.query,
        canonical: row.canonical,
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position,
        topUrl: row.topUrl ?? '',
      },
    })
    vectors.set(row.id, row.vector)
  }

  return {
    async index(nextDocs) {
      for (const doc of nextDocs) {
        docs.set(doc.id, doc)
        vectors.set(doc.id, embedText(doc.content))
      }
      return { count: nextDocs.length }
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 10
      const queryVector = embedText(query)
      const results: SearchResult[] = []
      for (const [id, vector] of vectors) {
        const doc = docs.get(id)
        if (!doc)
          continue
        results.push({
          id,
          score: cosine(queryVector, vector),
          ...(options.returnContent ? { content: doc.content } : {}),
          ...(options.returnMetadata !== false ? { metadata: doc.metadata } : {}),
        })
      }
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
    async remove(ids) {
      for (const id of ids) {
        docs.delete(id)
        vectors.delete(id)
      }
      return { count: ids.length }
    },
    async clear() {
      docs.clear()
      vectors.clear()
    },
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint')
    return Number(value)
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toNullableString(value: unknown): string | null {
  const s = String(value ?? '')
  return s.length > 0 ? s : null
}

function hitFromRow(row: SemanticKeywordRow, similarity: number): SemanticKeywordHit {
  return {
    id: row.id,
    query: row.query,
    canonical: row.canonical,
    similarity,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position,
    topUrl: row.topUrl,
  }
}

function bucketLabel(seed: SemanticKeywordRow, members: SemanticKeywordHit[]): string {
  const stop = new Set(['a', 'an', 'and', 'are', 'best', 'can', 'checker', 'for', 'free', 'google', 'how', 'in', 'is', 'me', 'my', 'of', 'online', 'the', 'to', 'tool', 'validator', 'what', 'with'])
  const counts = new Map<string, number>()
  for (const member of members.slice(0, 8)) {
    for (const token of normalizeKeyword(member.canonical || member.query).split(/[^a-z0-9]+/)) {
      if (token.length < 3 || stop.has(token))
        continue
      counts.set(token, (counts.get(token) ?? 0) + Math.log10(Math.max(10, member.impressions)))
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([token]) => token)
  return top.length > 0 ? top.join(' ') : seed.canonical || seed.query
}

export function useSemanticKeywordRepo(): SemanticRepoRunner {
  const rows = useState<SemanticKeywordRow[]>('semanticKeywordRepo:rows', () => [])
  const hits = useState<SemanticKeywordHit[]>('semanticKeywordRepo:hits', () => [])
  const buckets = useState<SemanticKeywordBucket[]>('semanticKeywordRepo:buckets', () => [])
  const topic = useState<string>('semanticKeywordRepo:topic', () => '')
  const loading = useState<boolean>('semanticKeywordRepo:loading', () => false)
  const searching = useState<boolean>('semanticKeywordRepo:searching', () => false)
  const error = useState<Error | null>('semanticKeywordRepo:error', () => null)
  const stats = useState<SemanticRepoStats | null>('semanticKeywordRepo:stats', () => null)
  const provider = useState<SearchProvider | null>('semanticKeywordRepo:provider', () => null)

  async function build(runner: AnalysisRunner, opts: { limit?: number } = {}): Promise<void> {
    if (loading.value)
      return

    loading.value = true
    error.value = null
    hits.value = []
    buckets.value = []

    try {
      const limit = opts.limit ?? 750
      const started = performance.now()
      const result = await runner.query(`
        WITH query_totals AS (
          SELECT
            query,
            any_value(query_canonical) AS canonical,
            SUM(clicks) AS clicks,
            SUM(impressions) AS impressions,
            SUM(sum_position) / NULLIF(SUM(impressions), 0) AS position
          FROM queries
          WHERE query IS NOT NULL AND query <> ''
          GROUP BY query
        ),
        url_totals AS (
          SELECT
            query,
            url,
            SUM(impressions) AS impressions,
            ROW_NUMBER() OVER (PARTITION BY query ORDER BY SUM(impressions) DESC) AS rank
          FROM page_queries
          WHERE query IS NOT NULL AND query <> '' AND url IS NOT NULL AND url <> ''
          GROUP BY query, url
        )
        SELECT
          q.query,
          q.canonical,
          q.clicks,
          q.impressions,
          q.position,
          u.url AS topUrl
        FROM query_totals q
        LEFT JOIN url_totals u ON u.query = q.query AND u.rank = 1
        ORDER BY q.impressions DESC
        LIMIT ${limit}
      `)

      const nextRows: SemanticKeywordRow[] = []
      for (let i = 0; i < result.rows.length; i += EMBED_BATCH_SIZE) {
        const batch = result.rows.slice(i, i + EMBED_BATCH_SIZE)
        for (const row of batch) {
          const query = String(row.query ?? '')
          if (!query)
            continue
          const canonical = String(row.canonical ?? normalizeKeyword(query))
          nextRows.push({
            id: keywordId(canonical || query),
            query,
            canonical,
            clicks: toNumber(row.clicks),
            impressions: toNumber(row.impressions),
            position: toNumber(row.position),
            topUrl: toNullableString(row.topUrl),
            vector: embedText(canonical || query),
          })
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }

      rows.value = nextRows
      provider.value = await createRetriv({ driver: createLocalKeywordProvider(nextRows) })
      if (!topic.value && nextRows[0])
        topic.value = nextRows[0].query
      stats.value = {
        keywords: nextRows.length,
        dimensions: DIMENSIONS,
        batches: Math.ceil(nextRows.length / EMBED_BATCH_SIZE),
        queryMs: result.queryMs + performance.now() - started,
      }
      bucket()
      await search()
    }
    catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
    }
    finally {
      loading.value = false
    }
  }

  async function search(nextTopic?: string): Promise<void> {
    if (nextTopic !== undefined)
      topic.value = nextTopic
    const q = topic.value.trim()
    if (!q || rows.value.length === 0) {
      hits.value = []
      return
    }

    searching.value = true
    try {
      const activeProvider = provider.value ?? createLocalKeywordProvider(rows.value)
      provider.value = activeProvider
      const results = await activeProvider.search(q, { limit: 25, returnMetadata: true })
      const byId = new Map(rows.value.map(row => [row.id, row]))
      hits.value = results
        .map((result) => {
          const row = byId.get(result.id)
          if (!row)
            return null
          return hitFromRow(row, result.score)
        })
        .filter((hit): hit is SemanticKeywordHit => hit !== null)
        .sort((a, b) => b.similarity - a.similarity || b.impressions - a.impressions)
        .slice(0, 25)
    }
    finally {
      searching.value = false
    }
  }

  function bucket(opts: { maxBuckets?: number, minSimilarity?: number, maxMembers?: number } = {}): void {
    const maxBuckets = opts.maxBuckets ?? DEFAULT_BUCKETS
    const minSimilarity = opts.minSimilarity ?? DEFAULT_BUCKET_SIMILARITY
    const maxMembers = opts.maxMembers ?? DEFAULT_BUCKET_MEMBERS
    const candidates = [...rows.value].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
    const assigned = new Set<string>()
    const nextBuckets: SemanticKeywordBucket[] = []

    for (const seed of candidates) {
      if (nextBuckets.length >= maxBuckets)
        break
      if (assigned.has(seed.id))
        continue

      const members = candidates
        .filter(row => !assigned.has(row.id))
        .map(row => hitFromRow(row, cosine(seed.vector, row.vector)))
        .filter(hit => hit.id === seed.id || hit.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity || b.impressions - a.impressions)
        .slice(0, maxMembers)

      if (members.length === 0)
        continue

      for (const member of members)
        assigned.add(member.id)

      const impressions = members.reduce((sum, member) => sum + member.impressions, 0)
      const clicks = members.reduce((sum, member) => sum + member.clicks, 0)
      const weightedPosition = members.reduce((sum, member) => sum + member.position * member.impressions, 0)
      const topUrl = [...members]
        .sort((a, b) => b.impressions - a.impressions)
        .find(member => member.topUrl)
        ?.topUrl ?? null

      nextBuckets.push({
        id: `bucket_${seed.id}`,
        label: bucketLabel(seed, members),
        seedQuery: seed.query,
        keywords: members.length,
        clicks,
        impressions,
        position: impressions > 0 ? weightedPosition / impressions : 0,
        topUrl,
        members,
      })
    }

    buckets.value = nextBuckets
  }

  return { rows, hits, buckets, topic, loading, searching, error, stats, provider, build, search, bucket }
}
