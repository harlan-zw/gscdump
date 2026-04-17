// Semantic content-gap detector. Loads MiniLM (22MB, cached in IndexedDB)
// in-browser via @huggingface/transformers, embeds top queries + URL-derived
// text, cosine-matches every query to every URL, flags queries where the
// actually-ranking URL is semantically distant from the best-matching URL.
//
// This is the "why does Google rank /blog/x for this query when /pricing
// would clearly be a better match" signal. GSC can't do it — it has no
// concept of semantic relevance, only observed SERP co-occurrence.

import type { InsightRunner } from './useInsightRunner'

export interface ContentGapResult {
  query: string
  impressions: number
  clicks: number
  avgPosition: number
  currentUrl: string
  currentSimilarity: number
  suggestedUrl: string
  suggestedSimilarity: number
  alternatives: Array<{ url: string, similarity: number }>
  divergence: number
  impact: number
}

export interface ContentGapProgress {
  phase: 'idle' | 'loading-model' | 'fetching-data' | 'embedding-queries' | 'embedding-urls' | 'computing-gaps' | 'done' | 'error'
  message: string
  done?: number
  total?: number
  modelMs?: number
  sqlMs?: number
  embedMs?: number
  computeMs?: number
}

export interface ContentGapOptions {
  /** Max queries to consider (by impressions). Default 1500. */
  maxQueries?: number
  /** Max URL candidates to consider. Default 400. */
  maxUrls?: number
  /** Min query impressions to be eligible. Default 50. */
  minImpressions?: number
  /** Min divergence (cosine delta) to report as a gap. Default 0.12. */
  minDivergence?: number
  /** WebGPU vs WASM. Default tries WebGPU with WASM fallback. */
  device?: 'webgpu' | 'wasm'
}

const ORIGIN_RE = /^https?:\/\/[^/]+/
const HTML_EXT_RE = /\.(html?|php|aspx?)$/i
const SEP_RE = /[-_]+/g
const DIGITS_ONLY_RE = /^\d+$/
const WWW_RE = /^www\./
const DOT_RE = /\./g
const HASH_RE = /#.*$/
const QUERY_RE = /\?.*$/
const TRAIL_SLASH_RE = /(?<=.)\/$/

// BGE models are trained with this exact prefix on queries. Skipping it
// costs 2-3 MTEB points on retrieval — the asymmetry is the point.
const MODEL_ID = 'Xenova/bge-base-en-v1.5'
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

// ---- IndexedDB embedding cache ----------------------------------------------
// Key = `${model}:${role}:${text}`. Values = raw Float32Array payload + dim.
// Namespaced by MODEL_ID so model upgrades invalidate old vectors automatically.

const DB_NAME = 'content-gap-embeddings'
const STORE = 'vectors'
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise != null)
    return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
  })
  return dbPromise
}

function cacheKey(role: 'query' | 'passage', text: string): string {
  return `${MODEL_ID}|${role}|${text}`
}

async function cacheGetMany(
  role: 'query' | 'passage',
  texts: string[],
): Promise<Map<string, Float32Array>> {
  const db = await openDb().catch(() => null)
  if (db == null)
    return new Map()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const out = new Map<string, Float32Array>()
    let pending = texts.length
    if (pending === 0) {
      resolve(out)
      return
    }
    for (const t of texts) {
      const req = store.get(cacheKey(role, t))
      req.onsuccess = () => {
        const v = req.result
        if (v instanceof Float32Array)
          out.set(t, v)
        pending -= 1
        if (pending === 0)
          resolve(out)
      }
      req.onerror = () => {
        pending -= 1
        if (pending === 0)
          resolve(out)
      }
    }
  })
}

async function cachePutMany(
  role: 'query' | 'passage',
  entries: Array<[string, Float32Array]>,
): Promise<void> {
  const db = await openDb().catch(() => null)
  if (db == null)
    return
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    for (const [text, vec] of entries)
      tx.objectStore(STORE).put(vec, cacheKey(role, text))
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}

// Strip fragment, query string, and trailing slash so /foo, /foo/, /foo?x=1,
// and /foo#bar all collapse to one URL. The embedder treats them as distinct
// (each derives the same text) which inflates the candidate list and lets
// anchor-deep-links outrank their parent page as "better" matches. Google
// doesn't care about the hash — this dedupe matches Google's behavior.
function normalizeUrl(u: string): string {
  try {
    const url = new URL(u)
    url.hash = ''
    url.search = ''
    let path = url.pathname
    if (path.length > 1 && path.endsWith('/'))
      path = path.slice(0, -1)
    return `${url.origin}${path}`
  }
  catch {
    return u.replace(HASH_RE, '').replace(QUERY_RE, '').replace(TRAIL_SLASH_RE, '')
  }
}

function deriveUrlText(url: string): string {
  try {
    const u = new URL(url)
    const segments = u.pathname.split('/').filter(Boolean)
    const parts = segments
      .map(s => decodeURIComponent(s).toLowerCase())
      .map(s => s.replace(HTML_EXT_RE, ''))
      .map(s => s.replace(SEP_RE, ' '))
      .filter(s => s.length > 0 && !DIGITS_ONLY_RE.test(s))
    const text = parts.join(' ')
    if (text.length > 0)
      return text
    // Homepage / empty path → use hostname stripped of "www." and TLD dots.
    return u.hostname.replace(WWW_RE, '').replace(DOT_RE, ' ')
  }
  catch {
    return url.replace(ORIGIN_RE, '').replace(SEP_RE, ' ')
  }
}

// Cosine similarity between two already L2-normalized vectors = dot product.
function cosineNormalized(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const n = a.length
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!
  return dot
}

type Extractor = (texts: string[], opts: { pooling: 'mean', normalize: boolean }) => Promise<{ data: Float32Array, dims: number[] }>

async function embedRawBatch(
  extractor: Extractor,
  texts: string[],
  onProgress: (done: number) => void,
  batchSize = 32,
): Promise<Float32Array[]> {
  const result: Float32Array[] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const out = await extractor(batch, { pooling: 'mean', normalize: true })
    const dim = out.dims[out.dims.length - 1]!
    for (let k = 0; k < batch.length; k++) {
      const start = k * dim
      // Slice to a standalone Float32Array so the underlying tensor can be GC'd.
      result.push(new Float32Array(out.data.buffer, out.data.byteOffset + start * 4, dim).slice())
    }
    onProgress(result.length)
  }
  return result
}

// Cached embed: resolves vectors for `texts` via IndexedDB lookup first,
// only running the model on the misses. `transform` lets callers apply the
// BGE query prefix to cache-miss inputs before feeding them to the encoder
// (cache is keyed on the unprefixed user-visible text so it survives
// prefix changes).
async function embedCached(
  extractor: Extractor,
  role: 'query' | 'passage',
  texts: string[],
  transform: (t: string) => string,
  onProgress: (done: number, total: number) => void,
): Promise<{ vectors: Float32Array[], hits: number, misses: number }> {
  const cached = await cacheGetMany(role, texts)
  const vectors: Float32Array[] = Array.from({ length: texts.length })
  const missIdx: number[] = []
  const missTexts: string[] = []

  for (let i = 0; i < texts.length; i++) {
    const hit = cached.get(texts[i]!)
    if (hit != null) {
      vectors[i] = hit
    }
    else {
      missIdx.push(i)
      missTexts.push(transform(texts[i]!))
    }
  }

  const hits = cached.size
  const misses = missTexts.length
  onProgress(hits, texts.length)

  if (missTexts.length > 0) {
    const embedded = await embedRawBatch(extractor, missTexts, (done) => {
      onProgress(hits + done, texts.length)
    })
    const toPersist: Array<[string, Float32Array]> = []
    for (let m = 0; m < embedded.length; m++) {
      const i = missIdx[m]!
      vectors[i] = embedded[m]!
      // Cache keyed on the original user-visible text, not the transformed one.
      toPersist.push([texts[i]!, embedded[m]!])
    }
    await cachePutMany(role, toPersist)
  }
  return { vectors, hits, misses }
}

export interface ContentGapRunner {
  progress: Ref<ContentGapProgress>
  results: Ref<ContentGapResult[]>
  error: Ref<Error | null>
  running: Ref<boolean>
  run: (runner: InsightRunner, opts?: ContentGapOptions) => Promise<void>
}

export function useContentGap(): ContentGapRunner {
  const progress = ref<ContentGapProgress>({ phase: 'idle', message: `Ready. First run downloads ~110MB ${MODEL_ID}; cached thereafter. Re-runs skip embedding via IndexedDB cache.` })
  const results = ref<ContentGapResult[]>([])
  const error = ref<Error | null>(null)
  const running = ref(false)

  async function run(runner: InsightRunner, opts: ContentGapOptions = {}): Promise<void> {
    if (running.value)
      return
    running.value = true
    error.value = null
    results.value = []
    const {
      maxQueries = 1500,
      maxUrls = 400,
      minImpressions = 50,
      minDivergence = 0.12,
      device,
    } = opts

    try {
      // 1. Load the model (cached in browser Cache API after first run).
      // WebGPU errors surface at inference time, not pipeline construction,
      // so a try/catch around pipeline() doesn't fallback reliably. Probe
      // `navigator.gpu.requestAdapter()` upfront instead.
      progress.value = { phase: 'loading-model', message: 'Checking device…' }
      const t0 = performance.now()
      let chosenDevice: 'webgpu' | 'wasm' = 'wasm'
      if (device === 'webgpu' || device == null) {
        const gpu = (globalThis as unknown as { navigator?: { gpu?: { requestAdapter: () => Promise<unknown> } } }).navigator?.gpu
        if (gpu != null) {
          const adapter = await gpu.requestAdapter().catch(() => null)
          if (adapter != null)
            chosenDevice = 'webgpu'
        }
      }
      progress.value = { phase: 'loading-model', message: `Loading ${MODEL_ID} on ${chosenDevice} (~110MB, cached after first run)…` }
      const { pipeline, env } = await import('@huggingface/transformers')
      // eslint-disable-next-line ts/ban-ts-comment
      // @ts-ignore — runtime-only field; typings lag behind
      env.useBrowserCache = true
      const extractor = await pipeline('feature-extraction', MODEL_ID, { device: chosenDevice, dtype: 'fp32' }) as unknown as Extractor
      const modelMs = performance.now() - t0

      // 2. Pull top queries (with their current best-ranking URL) + URL candidates from DuckDB.
      progress.value = { phase: 'fetching-data', message: `Running SQL (device: ${chosenDevice})…`, modelMs }
      const t1 = performance.now()
      const queryRes = await runner.query(`
        WITH query_totals AS (
          SELECT query,
            SUM(impressions)::BIGINT AS total_impressions,
            SUM(clicks)::BIGINT AS total_clicks,
            SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS avg_position
          FROM main.page_keywords
          WHERE query IS NOT NULL AND query <> ''
          GROUP BY query
          HAVING SUM(impressions) >= ${Number(minImpressions)}
          ORDER BY total_impressions DESC
          LIMIT ${Number(maxQueries)}
        ),
        per_query_url AS (
          SELECT pk.query, pk.url,
            SUM(pk.impressions)::BIGINT AS url_impressions,
            SUM(pk.sum_position) / NULLIF(SUM(pk.impressions), 0) + 1 AS url_position,
            ROW_NUMBER() OVER (PARTITION BY pk.query ORDER BY SUM(pk.impressions) DESC) AS rnk
          FROM main.page_keywords pk
          JOIN query_totals qt USING (query)
          WHERE pk.url IS NOT NULL AND pk.url <> ''
          GROUP BY pk.query, pk.url
        )
        SELECT q.query, q.total_impressions AS impressions, q.total_clicks AS clicks, q.avg_position,
          pu.url AS current_url, pu.url_position AS current_position
        FROM query_totals q
        JOIN per_query_url pu USING (query)
        WHERE pu.rnk = 1
      `)

      const urlRes = await runner.query(`
        SELECT url, SUM(impressions)::BIGINT AS impressions
        FROM main.page_keywords
        WHERE url IS NOT NULL AND url <> ''
        GROUP BY url
        ORDER BY impressions DESC
        LIMIT ${Number(maxUrls)}
      `)
      const sqlMs = performance.now() - t1

      const queries = queryRes.rows.map(r => String(r.query))
      // Dedupe URL candidates after normalization. Two raw URLs that collapse
      // to the same canonical form share an impression pool and one embedding.
      const urlAgg = new Map<string, number>()
      for (const r of urlRes.rows) {
        const norm = normalizeUrl(String(r.url))
        urlAgg.set(norm, (urlAgg.get(norm) ?? 0) + Number(r.impressions))
      }
      const urls = [...urlAgg.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Number(maxUrls))
        .map(([url]) => url)
      const urlTexts = urls.map(deriveUrlText)

      if (queries.length === 0 || urls.length === 0) {
        progress.value = { phase: 'done', message: 'Not enough data to analyze.', modelMs, sqlMs }
        running.value = false
        return
      }

      // 3. Embed queries. BGE asymmetry: queries get the retrieval prefix,
      // passages do not. Cache lookup is keyed on the unprefixed text so the
      // prefix is an implementation detail of the encoder.
      progress.value = { phase: 'embedding-queries', message: `Embedding ${queries.length} queries on ${chosenDevice}…`, total: queries.length, done: 0, modelMs, sqlMs }
      const t2 = performance.now()
      const queryEmbed = await embedCached(
        extractor,
        'query',
        queries,
        t => QUERY_PREFIX + t,
        (done, total) => {
          progress.value = { ...progress.value, done, total }
        },
      )

      // 4. Embed URL-derived text (passages — no prefix).
      progress.value = { phase: 'embedding-urls', message: `Embedding ${urls.length} URLs…`, total: urls.length, done: 0, modelMs, sqlMs }
      const urlEmbed = await embedCached(
        extractor,
        'passage',
        urlTexts,
        t => t,
        (done, total) => {
          progress.value = { ...progress.value, done, total }
        },
      )
      const embedMs = performance.now() - t2
      const queryEmbeddings = queryEmbed.vectors
      const urlEmbeddings = urlEmbed.vectors

      // 5. Compute content gaps.
      progress.value = { phase: 'computing-gaps', message: 'Computing semantic similarities…', modelMs, sqlMs, embedMs }
      const t3 = performance.now()
      const urlIndex = new Map<string, number>()
      for (let i = 0; i < urls.length; i++) urlIndex.set(urls[i]!, i)

      const gaps: ContentGapResult[] = []
      for (let i = 0; i < queryRes.rows.length; i++) {
        const qr = queryRes.rows[i]!
        const qEmb = queryEmbeddings[i]!
        const currentUrl = normalizeUrl(String(qr.current_url))
        const currentIdx = urlIndex.get(currentUrl)

        // Score every candidate URL.
        const scored: Array<{ url: string, similarity: number }> = Array.from({ length: urls.length })
        for (let j = 0; j < urls.length; j++) {
          scored[j] = { url: urls[j]!, similarity: cosineNormalized(qEmb, urlEmbeddings[j]!) }
        }
        scored.sort((a, b) => b.similarity - a.similarity)

        const currentSimilarity = currentIdx != null ? cosineNormalized(qEmb, urlEmbeddings[currentIdx]!) : 0
        const suggestedUrl = scored[0]!.url
        const suggestedSimilarity = scored[0]!.similarity

        if (suggestedUrl === currentUrl)
          continue
        const divergence = suggestedSimilarity - currentSimilarity
        if (divergence < minDivergence)
          continue

        const impressions = Number(qr.impressions)
        gaps.push({
          query: String(qr.query),
          impressions,
          clicks: Number(qr.clicks),
          avgPosition: Number(qr.avg_position),
          currentUrl,
          currentSimilarity,
          suggestedUrl,
          suggestedSimilarity,
          alternatives: scored.slice(1, 4),
          divergence,
          impact: impressions * divergence,
        })
      }
      gaps.sort((a, b) => b.impact - a.impact)
      const computeMs = performance.now() - t3

      results.value = gaps.slice(0, 150)
      const totalHits = queryEmbed.hits + urlEmbed.hits
      const totalInputs = queries.length + urls.length
      const cacheNote = totalHits > 0 ? ` · ${totalHits}/${totalInputs} cache hits` : ''
      progress.value = {
        phase: 'done',
        message: `Found ${gaps.length} content gaps across ${queries.length} queries${cacheNote}`,
        modelMs,
        sqlMs,
        embedMs,
        computeMs,
      }
    }
    catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      progress.value = { phase: 'error', message: error.value.message }
    }
    finally {
      running.value = false
    }
  }

  return { progress, results, error, running, run }
}
