import type { AnalysisQuerySource } from '@gscdump/engine/source'
import type { ContentGapEmbeddingRuntime } from './content-gap-embeddings'
import type { ContentGapQueryCandidate } from './content-gap-inputs'
import {
  createContentGapEmbeddingRuntime,
} from './content-gap-embeddings'
import { fetchContentGapInputs } from './content-gap-inputs'

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

export interface ContentGapAnalyzer {
  analyze: (source: AnalysisQuerySource, opts?: ContentGapOptions) => Promise<ContentGapAnalysis>
}

export interface CreateContentGapAnalyzerOptions {
  embeddings?: ContentGapEmbeddingRuntime
  loadInputs?: typeof fetchContentGapInputs
  now?: () => number
}

interface ResolvedContentGapRuntime {
  embeddings: ContentGapEmbeddingRuntime
  loadInputs: typeof fetchContentGapInputs
  now: () => number
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

export function rankContentGaps(
  queries: ContentGapQueryCandidate[],
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
    const top: Array<{ url: string, similarity: number }> = []
    let currentSimilarity = 0
    for (let j = 0; j < urls.length; j++) {
      const similarity = cosineNormalized(qEmb, urlEmbeddings[j]!)
      if (j === currentIdx)
        currentSimilarity = similarity

      // Only the recommendation and three alternatives are returned. Keep a
      // stable top-four list instead of allocating and sorting every URL for
      // every query (the default 1,500 x 400 input otherwise creates 600k
      // short-lived objects and performs 1,500 full sorts).
      let insertAt = top.length
      while (insertAt > 0 && similarity > top[insertAt - 1]!.similarity)
        insertAt--
      if (insertAt < 4) {
        top.splice(insertAt, 0, { url: urls[j]!, similarity })
        if (top.length > 4)
          top.pop()
      }
    }

    const suggested = top[0]
    if (!suggested)
      continue
    const suggestedUrl = suggested.url
    const suggestedSimilarity = suggested.similarity

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
      alternatives: top.slice(1),
      divergence,
      impact: qr.impressions * divergence,
    })
  }

  gaps.sort((a, b) => b.impact - a.impact)
  return gaps
}

async function runContentGapAnalysis(
  source: AnalysisQuerySource,
  opts: ContentGapOptions = {},
  runtime: ResolvedContentGapRuntime,
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
  const t0 = runtime.now()
  const chosenDevice = await runtime.embeddings.selectDevice(device)
  notify(onProgress, {
    phase: 'loading-model',
    message: `Loading ${runtime.embeddings.modelId} on ${chosenDevice} (~110MB, cached after first run)...`,
  })
  const extractor = await runtime.embeddings.loadExtractor(chosenDevice)
  const modelMs = runtime.now() - t0

  notify(onProgress, {
    phase: 'fetching-data',
    message: `Running SQL (device: ${chosenDevice})...`,
    modelMs,
  })
  const { queries, urls, sqlMs } = await runtime.loadInputs(executeSql, {
    maxQueries,
    maxUrls,
    minImpressions,
  }, normalizeUrl, runtime.now)

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
        modelId: runtime.embeddings.modelId,
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
  const t2 = runtime.now()
  const queryEmbed = await runtime.embeddings.embed(
    extractor,
    'query',
    queryTexts,
    t => runtime.embeddings.queryPrefix + t,
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
  const urlEmbed = await runtime.embeddings.embed(
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
  const embedMs = runtime.now() - t2

  notify(onProgress, {
    phase: 'computing-gaps',
    message: 'Computing semantic similarities...',
    modelMs,
    sqlMs,
    embedMs,
  })
  const t3 = runtime.now()
  const gaps = rankContentGaps(
    queries,
    urls,
    queryEmbed.vectors,
    urlEmbed.vectors,
    minDivergence,
  )
  const computeMs = runtime.now() - t3
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
      modelId: runtime.embeddings.modelId,
    },
  }
}

export function createContentGapAnalyzer(opts: CreateContentGapAnalyzerOptions = {}): ContentGapAnalyzer {
  const runtime: ResolvedContentGapRuntime = {
    embeddings: opts.embeddings ?? createContentGapEmbeddingRuntime(),
    loadInputs: opts.loadInputs ?? fetchContentGapInputs,
    now: opts.now ?? (() => performance.now()),
  }
  return {
    analyze(source, options) {
      return runContentGapAnalysis(source, options, runtime)
    },
  }
}

export function analyzeContentGap(
  source: AnalysisQuerySource,
  opts: ContentGapOptions = {},
): Promise<ContentGapAnalysis> {
  return createContentGapAnalyzer().analyze(source, opts)
}
