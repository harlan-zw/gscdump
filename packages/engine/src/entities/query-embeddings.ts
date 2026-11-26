// Opt-in per-canonical query embeddings sidecar beside `query_dim`
// (u_<u>/<s>/entities/query_embeddings/index.{parquet,json}).
//
// Stores symmetric Int8-quantized unit vectors as base64 in a VARCHAR Parquet
// column so `hyparquet` encodes and decodes them losslessly across Node,
// Workers, and browser without binary UTF-8 corruption. Core SQL analyzers
// never require this sidecar.

import type { TenantCtx } from '@gscdump/contracts'
import type { Row } from '../contracts'
import type { ColumnDef } from '../schema'
import type { DataSource } from '../storage'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { decodeParquetToRows, encodeRowsToParquetFlex } from '../adapters/hyparquet'
import { readOptional } from '../adapters/read-optional'
import { queryEmbeddingsMetaKey, queryEmbeddingsParquetKey } from '../entity-keys'

export { queryEmbeddingsMetaKey, queryEmbeddingsParquetKey } from '../entity-keys'

export const QUERY_EMBEDDINGS_SCHEMA_VERSION = 1

export interface QueryEmbeddingRecord {
  /** Primary key: canonical query string from `normalizeQuery()`. */
  query_canonical: string
  /** Embedding model identifier, e.g. `embeddinggemma:300m` or `@cf/baai/bge-m3`. */
  model: string
  /** Vector dimensionality. */
  dims: number
  /** Symmetric Int8 quantization scale (`maxAbs / 127` on the unit vector). */
  scale: number
  /** Base64-encoded Int8Array bytes (length === `dims`). */
  vec_i8_b64: string
  /** Normalizer version that produced `query_canonical`. */
  normalizer_version: number
}

/** JSON sidecar: model, dimensionality, quantization, and freshness metadata. */
export interface QueryEmbeddingsMeta {
  version: 1
  builtAt: number
  rowCount: number
  model: string
  dims: number
  normalizerVersion: number
  quantization: 'int8-symmetric'
}

export interface QuantizedEmbeddingInt8 {
  b64: string
  scale: number
  dims: number
}

const QUERY_EMBEDDINGS_COLUMNS: readonly ColumnDef[] = [
  { name: 'query_canonical', type: 'VARCHAR', nullable: false },
  { name: 'model', type: 'VARCHAR', nullable: false },
  { name: 'dims', type: 'INTEGER', nullable: false },
  { name: 'scale', type: 'DOUBLE', nullable: false },
  { name: 'vec_i8_b64', type: 'VARCHAR', nullable: false },
  { name: 'normalizer_version', type: 'INTEGER', nullable: false },
]

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < len ? bytes[i + 1]! : 0
    const c = i + 2 < len ? bytes[i + 2]! : 0
    const n = (a << 16) | (b << 8) | c
    out += BASE64_ALPHABET[(n >> 18) & 63]!
    out += BASE64_ALPHABET[(n >> 12) & 63]!
    out += i + 1 < len ? BASE64_ALPHABET[(n >> 6) & 63]! : '='
    out += i + 2 < len ? BASE64_ALPHABET[n & 63]! : '='
  }
  return out
}

const BASE64_DECODE = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < BASE64_ALPHABET.length; i++)
    table[BASE64_ALPHABET.charCodeAt(i)] = i
  return table
})()

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '')
  const outLen = Math.floor((clean.length * 3) / 4)
  const out = new Uint8Array(outLen)
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64_DECODE[clean.charCodeAt(i)] ?? -1
    const b = BASE64_DECODE[clean.charCodeAt(i + 1)] ?? -1
    const c = i + 2 < clean.length ? (BASE64_DECODE[clean.charCodeAt(i + 2)] ?? -1) : 0
    const d = i + 3 < clean.length ? (BASE64_DECODE[clean.charCodeAt(i + 3)] ?? -1) : 0
    if (a < 0 || b < 0 || c < 0 || d < 0)
      throw new Error('Invalid base64 embedding payload.')
    const n = (a << 18) | (b << 12) | (c << 6) | d
    if (o < outLen)
      out[o++] = (n >> 16) & 0xFF
    if (o < outLen)
      out[o++] = (n >> 8) & 0xFF
    if (o < outLen)
      out[o++] = n & 0xFF
  }
  return out
}

/**
 * L2-normalize a dense vector and quantize symmetrically into Int8 bytes.
 * Cosine similarity fidelity vs Float32 stays above 0.999 at ~4x smaller footprint.
 */
export function quantizeEmbeddingInt8(vec: readonly number[] | Float32Array): QuantizedEmbeddingInt8 {
  const dims = vec.length
  if (dims === 0)
    throw new Error('Cannot quantize an empty embedding vector.')

  let normSq = 0
  for (let i = 0; i < dims; i++) {
    const v = vec[i]!
    if (!Number.isFinite(v))
      throw new Error(`Embedding vector contains non-finite value at index ${i}.`)
    normSq += v * v
  }

  const q = new Int8Array(dims)
  if (normSq === 0) {
    return {
      b64: bytesToBase64(new Uint8Array(q.buffer, q.byteOffset, q.byteLength)),
      scale: 0,
      dims,
    }
  }

  const invNorm = 1 / Math.sqrt(normSq)
  let maxAbs = 0
  const unit = new Float32Array(dims)
  for (let i = 0; i < dims; i++) {
    const u = vec[i]! * invNorm
    unit[i] = u
    const abs = Math.abs(u)
    if (abs > maxAbs)
      maxAbs = abs
  }

  const scale = maxAbs / 127
  const invScale = scale > 0 ? 1 / scale : 0
  for (let i = 0; i < dims; i++) {
    const scaled = Math.round(unit[i]! * invScale)
    q[i] = scaled < -127 ? -127 : scaled > 127 ? 127 : scaled
  }

  return {
    b64: bytesToBase64(new Uint8Array(q.buffer, q.byteOffset, q.byteLength)),
    scale,
    dims,
  }
}

/**
 * Dequantize a symmetric Int8 base64 payload back into a unit-length Float32Array.
 */
export function dequantizeEmbeddingInt8(b64: string, scale: number, dims: number): Float32Array {
  const raw = base64ToBytes(b64)
  if (raw.length !== dims)
    throw new Error(`Embedding byte length mismatch: expected ${dims}, received ${raw.length}.`)
  const i8 = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const out = new Float32Array(dims)
  if (scale === 0)
    return out
  let normSq = 0
  for (let i = 0; i < dims; i++) {
    const v = i8[i]! * scale
    out[i] = v
    normSq += v * v
  }
  if (normSq > 0) {
    const invNorm = 1 / Math.sqrt(normSq)
    for (let i = 0; i < dims; i++)
      out[i] = out[i]! * invNorm
  }
  return out
}

export interface BuildQueryEmbeddingEntry {
  queryCanonical: string
  vector: readonly number[] | Float32Array
}

export interface BuildQueryEmbeddingsOptions {
  model: string
  normalizerVersion: number
}

/**
 * Pure: convert canonical query + dense vector pairs into deduplicated,
 * sorted `QueryEmbeddingRecord[]` ready for Parquet persistence.
 */
export function buildQueryEmbeddingRecords(
  entries: Iterable<BuildQueryEmbeddingEntry>,
  options: BuildQueryEmbeddingsOptions,
): QueryEmbeddingRecord[] {
  const byCanonical = new Map<string, QueryEmbeddingRecord>()
  let expectedDims: number | null = null

  for (const entry of entries) {
    const canonical = entry.queryCanonical.trim()
    if (!canonical)
      continue
    const quantized = quantizeEmbeddingInt8(entry.vector)
    if (expectedDims === null)
      expectedDims = quantized.dims
    else if (quantized.dims !== expectedDims)
      throw new Error(`Inconsistent embedding dimensions: expected ${expectedDims}, got ${quantized.dims} for "${canonical}".`)

    byCanonical.set(canonical, {
      query_canonical: canonical,
      model: options.model,
      dims: quantized.dims,
      scale: quantized.scale,
      vec_i8_b64: quantized.b64,
      normalizer_version: options.normalizerVersion,
    })
  }

  return [...byCanonical.values()].sort((a, b) =>
    a.query_canonical < b.query_canonical ? -1 : a.query_canonical > b.query_canonical ? 1 : 0,
  )
}

export interface QueryEmbeddingsWriteResult {
  parquetKey: string
  rowCount: number
  bytes: number
}

export interface QueryEmbeddingsStore {
  parquetKey: (ctx: TenantCtx) => string
  /** Replace the sidecar Parquet + JSON metadata. */
  write: (ctx: TenantCtx, records: readonly QueryEmbeddingRecord[], builtAt: number) => Promise<QueryEmbeddingsWriteResult>
  /**
   * Incrementally merge new records into the existing sidecar when model, dims,
   * and normalizer_version match; cleanly replaces if any space parameter changed.
   */
  mergeWrite: (ctx: TenantCtx, newRecords: readonly QueryEmbeddingRecord[], builtAt: number) => Promise<QueryEmbeddingsWriteResult & { replaced: boolean }>
  /** Read JSON metadata without decoding Parquet, or null if absent. */
  loadMeta: (ctx: TenantCtx) => Promise<QueryEmbeddingsMeta | null>
  /** Decode all stored embedding records, or [] if absent. */
  loadRecords: (ctx: TenantCtx) => Promise<QueryEmbeddingRecord[]>
}

export function createQueryEmbeddingsStore({ dataSource }: { dataSource: DataSource }): QueryEmbeddingsStore {
  const write = async (
    ctx: TenantCtx,
    records: readonly QueryEmbeddingRecord[],
    builtAt: number,
  ): Promise<QueryEmbeddingsWriteResult> => {
    const sorted = [...records].sort((a, b) =>
      a.query_canonical < b.query_canonical ? -1 : a.query_canonical > b.query_canonical ? 1 : 0,
    )
    const parquetKey = queryEmbeddingsParquetKey(ctx)
    const bytes = encodeRowsToParquetFlex(sorted as unknown as readonly Row[], {
      columns: QUERY_EMBEDDINGS_COLUMNS,
      sortKey: ['query_canonical'],
    })
    await dataSource.write(parquetKey, bytes)
    const first = sorted[0]
    const meta: QueryEmbeddingsMeta = {
      version: QUERY_EMBEDDINGS_SCHEMA_VERSION,
      builtAt,
      rowCount: sorted.length,
      model: first?.model ?? '',
      dims: first?.dims ?? 0,
      normalizerVersion: first?.normalizer_version ?? 0,
      quantization: 'int8-symmetric',
    }
    await dataSource.write(queryEmbeddingsMetaKey(ctx), encodeJsonBigintSafe(meta))
    return { parquetKey, rowCount: sorted.length, bytes: bytes.byteLength }
  }

  const loadMeta = async (ctx: TenantCtx): Promise<QueryEmbeddingsMeta | null> => {
    const bytes = await readOptional(dataSource, queryEmbeddingsMetaKey(ctx))
    if (!bytes)
      return null
    return JSON.parse(new TextDecoder().decode(bytes)) as QueryEmbeddingsMeta
  }

  const loadRecords = async (ctx: TenantCtx): Promise<QueryEmbeddingRecord[]> => {
    const bytes = await readOptional(dataSource, queryEmbeddingsParquetKey(ctx))
    if (!bytes)
      return []
    const rows = await decodeParquetToRows(bytes)
    return rows.map(r => ({
      query_canonical: String(r.query_canonical),
      model: String(r.model),
      dims: Number(r.dims),
      scale: Number(r.scale),
      vec_i8_b64: String(r.vec_i8_b64),
      normalizer_version: Number(r.normalizer_version),
    }))
  }

  return {
    parquetKey: queryEmbeddingsParquetKey,
    write,
    loadMeta,
    loadRecords,

    async mergeWrite(ctx, newRecords, builtAt) {
      if (newRecords.length === 0) {
        const existing = await loadRecords(ctx)
        const res = await write(ctx, existing, builtAt)
        return { ...res, replaced: false }
      }
      const target = newRecords[0]!
      const existingMeta = await loadMeta(ctx)
      const compatible = existingMeta !== null
        && existingMeta.model === target.model
        && existingMeta.dims === target.dims
        && existingMeta.normalizerVersion === target.normalizer_version

      const merged = new Map<string, QueryEmbeddingRecord>()
      if (compatible) {
        for (const rec of await loadRecords(ctx))
          merged.set(rec.query_canonical, rec)
      }
      for (const rec of newRecords)
        merged.set(rec.query_canonical, rec)

      const res = await write(ctx, [...merged.values()], builtAt)
      return { ...res, replaced: existingMeta !== null && !compatible }
    },
  }
}
