export const CONTENT_GAP_MODEL_ID = 'Xenova/bge-base-en-v1.5'
export const CONTENT_GAP_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

type ContentGapDevice = 'webgpu' | 'wasm'
type ContentGapEmbeddingRole = 'query' | 'passage'
type ContentGapExtractor = (
  texts: string[],
  opts: { pooling: 'mean', normalize: boolean },
) => Promise<{ data: Float32Array, dims: number[] }>

interface EmbeddedContentGapTexts {
  vectors: Float32Array[]
  hits: number
  misses: number
}

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

function cacheKey(role: ContentGapEmbeddingRole, text: string): string {
  return `${CONTENT_GAP_MODEL_ID}|${role}|${text}`
}

async function cacheGetMany(
  role: ContentGapEmbeddingRole,
  texts: string[],
): Promise<Map<string, Float32Array>> {
  // Ignorable by design: the embedding cache is a pure optimisation. If
  // IndexedDB is unavailable (private mode, blocked, quota), we treat every
  // text as a cache miss and re-embed; correctness is unaffected.
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
  role: ContentGapEmbeddingRole,
  entries: Array<[string, Float32Array]>,
): Promise<void> {
  // Ignorable by design: failing to persist to the embedding cache only costs
  // a re-embed on the next run; it never changes this run's result.
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
  extractor: ContentGapExtractor,
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

export async function selectContentGapDevice(requested?: ContentGapDevice): Promise<ContentGapDevice> {
  let chosenDevice: ContentGapDevice = 'wasm'
  if (requested === 'webgpu' || requested == null) {
    const gpu = (globalThis as unknown as { navigator?: { gpu?: { requestAdapter: () => Promise<unknown> } } }).navigator?.gpu
    if (gpu != null) {
      // Ignorable by design: a failed/absent WebGPU adapter is a capability
      // probe, not an error. We fall back to the 'wasm' device.
      const adapter = await gpu.requestAdapter().catch(() => null)
      if (adapter != null)
        chosenDevice = 'webgpu'
    }
  }
  return chosenDevice
}

export async function loadContentGapExtractor(device: ContentGapDevice): Promise<ContentGapExtractor> {
  const { pipeline, env } = await import('@huggingface/transformers')
  // eslint-disable-next-line ts/ban-ts-comment
  // @ts-ignore runtime-only field; typings lag behind
  env.useBrowserCache = true
  return await pipeline('feature-extraction', CONTENT_GAP_MODEL_ID, { device, dtype: 'fp32' }) as unknown as ContentGapExtractor
}

export async function embedContentGapTexts(
  extractor: ContentGapExtractor,
  role: ContentGapEmbeddingRole,
  texts: string[],
  transform: (t: string) => string,
  onProgress: (done: number, total: number) => void,
): Promise<EmbeddedContentGapTexts> {
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
