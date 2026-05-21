import type { AnalysisQuerySource, QueryRow } from '@gscdump/engine/source'

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
  maxQueries?: number
  maxUrls?: number
  minImpressions?: number
  minDivergence?: number
  device?: 'webgpu' | 'wasm'
  onProgress?: (progress: ContentGapProgress) => void
}

/**
 * Content-gap requires a source with a raw-SQL escape hatch. The analyzer's
 * query shape (CTEs + window functions against `main.page_queries`) isn't
 * expressible as a {@link BuilderState}, so it bypasses `queryRows` and
 * goes directly through `source.executeSql`.
 */
export class ContentGapSourceUnsupportedError extends Error {
  constructor(kind: string) {
    super(`content-gap requires a source with executeSql (got '${kind}'); use createBrowserQuerySource or createSqliteQuerySource`)
    this.name = 'ContentGapSourceUnsupportedError'
  }
}

export interface ContentGapAnalysis {
  results: ContentGapResult[]
  meta: {
    modelMs: number
    sqlMs: number
    embedMs: number
    computeMs: number
    cacheHits: number
    totalInputs: number
    device: 'webgpu' | 'wasm'
    modelId: string
  }
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

const MODEL_ID = 'Xenova/bge-base-en-v1.5'
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

const DB_NAME = 'content-gap-embeddings'
const STORE = 'vectors'
let dbPromise: Promise<IDBDatabase> | null = null

type Extractor = (texts: string[], opts: { pooling: 'mean', normalize: boolean }) => Promise<{ data: Float32Array, dims: number[] }>

interface QueryCandidate {
  query: string
  impressions: number
  clicks: number
  avgPosition: number
  currentUrl: string
}

export function normalizeUrl(u: string): string {
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

export function deriveUrlText(url: string): string {
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
    return u.hostname.replace(WWW_RE, '').replace(DOT_RE, ' ')
  }
  catch {
    return url.replace(ORIGIN_RE, '').replace(SEP_RE, ' ')
  }
}

export function cosineNormalized(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const n = a.length
  for (let i = 0; i < n; i++)
    dot += a[i]! * b[i]!
  return dot
}

function notify(onProgress: ContentGapOptions['onProgress'], progress: ContentGapProgress): void {
  onProgress?.(progress)
}

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
      result.push(new Float32Array(out.data.buffer, out.data.byteOffset + start * 4, dim).slice())
    }
    onProgress(result.length)
  }
  return result
}

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
      toPersist.push([texts[i]!, embedded[m]!])
    }
    await cachePutMany(role, toPersist)
  }

  return { vectors, hits, misses }
}

async function selectDevice(requested?: 'webgpu' | 'wasm'): Promise<'webgpu' | 'wasm'> {
  let chosenDevice: 'webgpu' | 'wasm' = 'wasm'
  if (requested === 'webgpu' || requested == null) {
    const gpu = (globalThis as unknown as { navigator?: { gpu?: { requestAdapter: () => Promise<unknown> } } }).navigator?.gpu
    if (gpu != null) {
      const adapter = await gpu.requestAdapter().catch(() => null)
      if (adapter != null)
        chosenDevice = 'webgpu'
    }
  }
  return chosenDevice
}

async function loadExtractor(device: 'webgpu' | 'wasm'): Promise<Extractor> {
  const { pipeline, env } = await import('@huggingface/transformers')
  // eslint-disable-next-line ts/ban-ts-comment
  // @ts-ignore runtime-only field; typings lag behind
  env.useBrowserCache = true
  return await pipeline('feature-extraction', MODEL_ID, { device, dtype: 'fp32' }) as unknown as Extractor
}

async function fetchContentGapInputs(
  executeSql: (sql: string, params?: unknown[]) => Promise<QueryRow[]>,
  options: Required<Pick<ContentGapOptions, 'maxQueries' | 'maxUrls' | 'minImpressions'>>,
): Promise<{ queries: QueryCandidate[], urls: string[], sqlMs: number }> {
  const t1 = performance.now()
  const queryRows = await executeSql(`
    WITH query_totals AS (
      SELECT query,
        SUM(impressions)::BIGINT AS total_impressions,
        SUM(clicks)::BIGINT AS total_clicks,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS avg_position
      FROM main.page_queries
      WHERE query IS NOT NULL AND query <> ''
      GROUP BY query
      HAVING SUM(impressions) >= ?
      ORDER BY total_impressions DESC
      LIMIT ?
    ),
    per_query_url AS (
      SELECT pk.query, pk.url,
        SUM(pk.impressions)::BIGINT AS url_impressions,
        SUM(pk.sum_position) / NULLIF(SUM(pk.impressions), 0) + 1 AS url_position,
        ROW_NUMBER() OVER (PARTITION BY pk.query ORDER BY SUM(pk.impressions) DESC) AS rnk
      FROM main.page_queries pk
      JOIN query_totals qt USING (query)
      WHERE pk.url IS NOT NULL AND pk.url <> ''
      GROUP BY pk.query, pk.url
    )
    SELECT q.query, q.total_impressions AS impressions, q.total_clicks AS clicks, q.avg_position,
      pu.url AS current_url, pu.url_position AS current_position
    FROM query_totals q
    JOIN per_query_url pu USING (query)
    WHERE pu.rnk = 1
  `, [Number(options.minImpressions), Number(options.maxQueries)])

  const urlRows = await executeSql(`
    SELECT url, SUM(impressions)::BIGINT AS impressions
    FROM main.page_queries
    WHERE url IS NOT NULL AND url <> ''
    GROUP BY url
    ORDER BY impressions DESC
    LIMIT ?
  `, [Number(options.maxUrls)])
  const sqlMs = performance.now() - t1

  const queries = queryRows.map(row => ({
    query: String(row.query),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    avgPosition: Number(row.avg_position),
    currentUrl: normalizeUrl(String(row.current_url)),
  }))

  const urlAgg = new Map<string, number>()
  for (const row of urlRows) {
    const norm = normalizeUrl(String(row.url))
    urlAgg.set(norm, (urlAgg.get(norm) ?? 0) + Number(row.impressions))
  }
  const urls = [...urlAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(options.maxUrls))
    .map(([url]) => url)

  return { queries, urls, sqlMs }
}

export function rankContentGaps(
  queries: QueryCandidate[],
  urls: string[],
  queryEmbeddings: Float32Array[],
  urlEmbeddings: Float32Array[],
  minDivergence: number,
): ContentGapResult[] {
  const urlIndex = new Map<string, number>()
  for (let i = 0; i < urls.length; i++)
    urlIndex.set(urls[i]!, i)

  const gaps: ContentGapResult[] = []
  for (let i = 0; i < queries.length; i++) {
    const qr = queries[i]!
    const qEmb = queryEmbeddings[i]!
    const currentIdx = urlIndex.get(qr.currentUrl)

    const scored: Array<{ url: string, similarity: number }> = Array.from({ length: urls.length })
    for (let j = 0; j < urls.length; j++) {
      scored[j] = {
        url: urls[j]!,
        similarity: cosineNormalized(qEmb, urlEmbeddings[j]!),
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity)

    const currentSimilarity = currentIdx != null ? cosineNormalized(qEmb, urlEmbeddings[currentIdx]!) : 0
    const suggestedUrl = scored[0]!.url
    const suggestedSimilarity = scored[0]!.similarity

    if (suggestedUrl === qr.currentUrl)
      continue
    const divergence = suggestedSimilarity - currentSimilarity
    if (divergence < minDivergence)
      continue

    gaps.push({
      query: qr.query,
      impressions: qr.impressions,
      clicks: qr.clicks,
      avgPosition: qr.avgPosition,
      currentUrl: qr.currentUrl,
      currentSimilarity,
      suggestedUrl,
      suggestedSimilarity,
      alternatives: scored.slice(1, 4),
      divergence,
      impact: qr.impressions * divergence,
    })
  }

  gaps.sort((a, b) => b.impact - a.impact)
  return gaps
}

export async function analyzeContentGap(
  source: AnalysisQuerySource,
  opts: ContentGapOptions = {},
): Promise<ContentGapAnalysis> {
  if (!source.executeSql)
    throw new ContentGapSourceUnsupportedError(source.name ?? 'unknown')
  const executeSql = source.executeSql.bind(source)
  const {
    maxQueries = 1500,
    maxUrls = 400,
    minImpressions = 50,
    minDivergence = 0.12,
    device,
    onProgress,
  } = opts

  notify(onProgress, { phase: 'loading-model', message: 'Checking device...' })
  const t0 = performance.now()
  const chosenDevice = await selectDevice(device)
  notify(onProgress, {
    phase: 'loading-model',
    message: `Loading ${MODEL_ID} on ${chosenDevice} (~110MB, cached after first run)...`,
  })
  const extractor = await loadExtractor(chosenDevice)
  const modelMs = performance.now() - t0

  notify(onProgress, {
    phase: 'fetching-data',
    message: `Running SQL (device: ${chosenDevice})...`,
    modelMs,
  })
  const { queries, urls, sqlMs } = await fetchContentGapInputs(executeSql, {
    maxQueries,
    maxUrls,
    minImpressions,
  })

  if (queries.length === 0 || urls.length === 0) {
    notify(onProgress, {
      phase: 'done',
      message: 'Not enough data to analyze.',
      modelMs,
      sqlMs,
    })
    return {
      results: [],
      meta: {
        modelMs,
        sqlMs,
        embedMs: 0,
        computeMs: 0,
        cacheHits: 0,
        totalInputs: 0,
        device: chosenDevice,
        modelId: MODEL_ID,
      },
    }
  }

  const queryTexts = queries.map(q => q.query)
  const urlTexts = urls.map(deriveUrlText)

  notify(onProgress, {
    phase: 'embedding-queries',
    message: `Embedding ${queryTexts.length} queries on ${chosenDevice}...`,
    total: queryTexts.length,
    done: 0,
    modelMs,
    sqlMs,
  })
  const t2 = performance.now()
  const queryEmbed = await embedCached(
    extractor,
    'query',
    queryTexts,
    t => QUERY_PREFIX + t,
    (done, total) => {
      notify(onProgress, {
        phase: 'embedding-queries',
        message: `Embedding ${queryTexts.length} queries on ${chosenDevice}...`,
        done,
        total,
        modelMs,
        sqlMs,
      })
    },
  )

  notify(onProgress, {
    phase: 'embedding-urls',
    message: `Embedding ${urls.length} URLs...`,
    total: urls.length,
    done: 0,
    modelMs,
    sqlMs,
  })
  const urlEmbed = await embedCached(
    extractor,
    'passage',
    urlTexts,
    t => t,
    (done, total) => {
      notify(onProgress, {
        phase: 'embedding-urls',
        message: `Embedding ${urls.length} URLs...`,
        done,
        total,
        modelMs,
        sqlMs,
      })
    },
  )
  const embedMs = performance.now() - t2

  notify(onProgress, {
    phase: 'computing-gaps',
    message: 'Computing semantic similarities...',
    modelMs,
    sqlMs,
    embedMs,
  })
  const t3 = performance.now()
  const gaps = rankContentGaps(
    queries,
    urls,
    queryEmbed.vectors,
    urlEmbed.vectors,
    minDivergence,
  )
  const computeMs = performance.now() - t3
  const totalHits = queryEmbed.hits + urlEmbed.hits
  const totalInputs = queryTexts.length + urls.length
  const cacheNote = totalHits > 0 ? ` · ${totalHits}/${totalInputs} cache hits` : ''

  notify(onProgress, {
    phase: 'done',
    message: `Found ${gaps.length} content gaps across ${queries.length} queries${cacheNote}`,
    modelMs,
    sqlMs,
    embedMs,
    computeMs,
  })

  return {
    results: gaps.slice(0, 150),
    meta: {
      modelMs,
      sqlMs,
      embedMs,
      computeMs,
      cacheHits: totalHits,
      totalInputs,
      device: chosenDevice,
      modelId: MODEL_ID,
    },
  }
}
