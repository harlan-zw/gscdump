export const CONTENT_GAP_MODEL_ID = 'Xenova/bge-base-en-v1.5'
export const CONTENT_GAP_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

export type ContentGapDevice = 'webgpu' | 'wasm'
export type ContentGapEmbeddingRole = 'query' | 'passage'
export type ContentGapExtractor = (
  texts: string[],
  opts: { pooling: 'mean', normalize: boolean },
) => Promise<{ data: Float32Array, dims: number[] }>

export interface EmbeddedContentGapTexts {
  vectors: Float32Array[]
  hits: number
  misses: number
}

const DB_NAME = 'content-gap-embeddings'
const STORE = 'vectors'

export interface ContentGapEmbeddingCache {
  getMany: (role: ContentGapEmbeddingRole, texts: string[]) => Promise<Map<string, Float32Array>>
  putMany: (role: ContentGapEmbeddingRole, entries: Array<[string, Float32Array]>) => Promise<void>
}

function cacheKey(role: ContentGapEmbeddingRole, text: string): string {
  return `${CONTENT_GAP_MODEL_ID}|${role}|${text}`
}

export function createIndexedDbContentGapCache(): ContentGapEmbeddingCache {
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
  return {
    async getMany(role, texts) {
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
        for (const text of texts) {
          const req = store.get(cacheKey(role, text))
          req.onsuccess = () => {
            if (req.result instanceof Float32Array)
              out.set(text, req.result)
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
    },
    async putMany(role, entries) {
      const db = await openDb().catch(() => null)
      if (db == null)
        return
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        for (const [text, vector] of entries)
          tx.objectStore(STORE).put(vector, cacheKey(role, text))
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      })
    },
  }
}

export function createMemoryContentGapCache(): ContentGapEmbeddingCache {
  const values = new Map<string, Float32Array>()
  return {
    async getMany(role, texts) {
      const out = new Map<string, Float32Array>()
      for (const text of texts) {
        const value = values.get(cacheKey(role, text))
        if (value)
          out.set(text, value)
      }
      return out
    },
    async putMany(role, entries) {
      for (const [text, vector] of entries)
        values.set(cacheKey(role, text), vector)
    },
  }
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
  cache: ContentGapEmbeddingCache,
): Promise<EmbeddedContentGapTexts> {
  const cached = await cache.getMany(role, texts)
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
    await cache.putMany(role, toPersist)
  }

  return { vectors, hits, misses }
}

export interface ContentGapEmbeddingRuntime {
  modelId: string
  queryPrefix: string
  selectDevice: (requested?: ContentGapDevice) => Promise<ContentGapDevice>
  loadExtractor: (device: ContentGapDevice) => Promise<ContentGapExtractor>
  embed: (
    extractor: ContentGapExtractor,
    role: ContentGapEmbeddingRole,
    texts: string[],
    transform: (text: string) => string,
    onProgress: (done: number, total: number) => void,
  ) => Promise<EmbeddedContentGapTexts>
}

export function createContentGapEmbeddingRuntime(
  cache: ContentGapEmbeddingCache = createIndexedDbContentGapCache(),
): ContentGapEmbeddingRuntime {
  return {
    modelId: CONTENT_GAP_MODEL_ID,
    queryPrefix: CONTENT_GAP_QUERY_PREFIX,
    selectDevice: selectContentGapDevice,
    loadExtractor: loadContentGapExtractor,
    embed(extractor, role, texts, transform, onProgress) {
      return embedContentGapTexts(extractor, role, texts, transform, onProgress, cache)
    },
  }
}
