import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restCatalogLoadTable } from '../src/unsafe-raw'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }

// The JSON parser that icebird 0.8.30 shipped, kept as the identity oracle.
// It builds each string one character at a time.
function parseIcebird0830(text: string): unknown {
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
  let i = 0
  function skipWs(): void {
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D)
        break
      i++
    }
  }
  function parseString(): string {
    if (text[i] !== '"')
      throw new Error(`expected " at ${i}`)
    i++
    let s = ''
    while (i < text.length) {
      const c = text[i++]!
      if (c === '"')
        return s
      if (c !== '\\') {
        s += c
        continue
      }
      const e = text[i++]
      if (e === 'u') {
        s += String.fromCharCode(Number.parseInt(text.slice(i, i + 4), 16))
        i += 4
      }
      else {
        s += ESCAPES[e!] ?? e
      }
    }
    throw new Error('unterminated string')
  }
  function parseNumber(): number | bigint {
    const start = i
    if (text[i] === '-')
      i++
    while (text[i]! >= '0' && text[i]! <= '9') i++
    const intEnd = i
    let isFloat = false
    if (text[i] === '.') {
      isFloat = true
      i++
      while (text[i]! >= '0' && text[i]! <= '9') i++
    }
    if (text[i] === 'e' || text[i] === 'E') {
      isFloat = true
      i++
      if (text[i] === '+' || text[i] === '-')
        i++
      while (text[i]! >= '0' && text[i]! <= '9') i++
    }
    if (isFloat)
      return Number(text.slice(start, i))
    const intStr = text.slice(start, intEnd)
    if (intStr.length >= 16) {
      const n = BigInt(intStr)
      if (n > MAX_SAFE || n < -MAX_SAFE)
        return n
    }
    return Number(intStr)
  }
  function parseLiteral(lit: string, val: unknown): unknown {
    if (text.slice(i, i + lit.length) !== lit)
      throw new Error(`bad literal at ${i}`)
    i += lit.length
    return val
  }
  function parseValue(): unknown {
    skipWs()
    const ch = text[i]
    if (ch === '"')
      return parseString()
    if (ch === '{')
      return parseObject()
    if (ch === '[')
      return parseArray()
    if (ch === 't')
      return parseLiteral('true', true)
    if (ch === 'f')
      return parseLiteral('false', false)
    if (ch === 'n')
      return parseLiteral('null', null)
    return parseNumber()
  }
  function parseObject(): Record<string, unknown> {
    i++
    skipWs()
    const obj: Record<string, unknown> = {}
    if (text[i] === '}') {
      i++
      return obj
    }
    while (true) {
      skipWs()
      const key = parseString()
      skipWs()
      if (text[i] !== ':')
        throw new Error(`expected : at ${i}`)
      i++
      obj[key] = parseValue()
      skipWs()
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === '}') {
        i++
        return obj
      }
      throw new Error(`expected , or } at ${i}`)
    }
  }
  function parseArray(): unknown[] {
    i++
    skipWs()
    const arr: unknown[] = []
    if (text[i] === ']') {
      i++
      return arr
    }
    while (true) {
      arr.push(parseValue())
      skipWs()
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === ']') {
        i++
        return arr
      }
      throw new Error(`expected , or ] at ${i}`)
    }
  }
  const value = parseValue()
  skipWs()
  if (i !== text.length)
    throw new Error(`unexpected trailing input at ${i}`)
  return value
}

// A REST catalog loadTable body shaped like R2 Data Catalog output: thousands
// of snapshots with 64-bit ids above 2^53, which JSON.parse would round.
function loadTableBody(snapshotCount: number): string {
  const base = 6_000_000_000_000_000_000n
  const snapshots: string[] = []
  const log: string[] = []
  for (let n = 0; n < snapshotCount; n++) {
    const id = base + BigInt(n) * 7_919n
    const parent = n === 0 ? '' : `"parent-snapshot-id": ${base + BigInt(n - 1) * 7_919n}, `
    const ts = 1_760_000_000_000 + n * 60_000
    snapshots.push(`{"snapshot-id": ${id}, ${parent}"sequence-number": ${n + 1}, "timestamp-ms": ${ts}, `
      + `"manifest-list": "s3://warehouse/gsc/pages/metadata/snap-${id}-1-0198a6c1-${n.toString(16).padStart(8, '0')}.avro", `
      + `"summary": {"operation": "append", "added-data-files": "1", "added-records": "${n * 31}", `
      + `"added-files-size": "${n * 4096}", "changed-partition-count": "1", "total-records": "${n * 977}", `
      + `"total-files-size": "${n * 65_536}", "total-data-files": "${n + 1}", "total-delete-files": "0", `
      + `"engine-name": "gscdump \\"lakehouse\\" caf\\u00e9 \\/ \\t", "app-id": "site-${n % 97}"}, "schema-id": 0}`)
    log.push(`{"snapshot-id": ${id}, "timestamp-ms": ${ts}}`)
  }
  const last = base + BigInt(snapshotCount - 1) * 7_919n
  return `{"metadata-location": "s3://warehouse/gsc/pages/metadata/00042-a.metadata.json", "config": {}, "metadata": {`
    + `"format-version": 2, "table-uuid": "0198a6c1-1f2e-7c3d-8e4f-5a6b7c8d9e0f", "location": "s3://warehouse/gsc/pages", `
    + `"last-sequence-number": ${snapshotCount}, "last-updated-ms": 1760000000000, "last-column-id": 4, "current-schema-id": 0, `
    + `"schemas": [{"type": "struct", "schema-id": 0, "fields": [`
    + `{"id": 1, "name": "site_id", "required": true, "type": "int"}, {"id": 2, "name": "date", "required": true, "type": "date"}, `
    + `{"id": 3, "name": "clicks", "required": false, "type": "long"}, {"id": 4, "name": "position", "required": false, "type": "double"}]}], `
    + `"default-spec-id": 0, "partition-specs": [{"spec-id": 0, "fields": [{"source-id": 1, "field-id": 1000, "name": "site_id", "transform": "identity"}]}], `
    + `"last-partition-id": 1000, "default-sort-order-id": 0, "sort-orders": [{"order-id": 0, "fields": []}], `
    + `"properties": {"write.parquet.compression-codec": "zstd", "commit.retry.num-retries": "4"}, `
    + `"current-snapshot-id": ${last}, "refs": {"main": {"snapshot-id": ${last}, "type": "branch"}}, `
    + `"snapshots": [${snapshots.join(', ')}], "snapshot-log": [${log.join(', ')}], "metadata-log": [], `
    + `"statistics": [], "partition-statistics": [], "position": -1.5e-3}}`
}

// Registered-host appends record their provider request in a snapshot summary
// value, so the value is JSON inside JSON and carries many escaped quotes.
function escapedSummaryBody(snapshotCount: number): string {
  const request = JSON.stringify({
    propertyUrl: 'sc-domain:example.test',
    request: { startDate: '2025-07-01', endDate: '2025-07-01', dimensions: ['page', 'query', 'date'], dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: '^https?://www\\.example\\.test/' }] }], rowLimit: 500, type: 'web', dataState: 'all' },
  })
  const snapshots = Array.from({ length: snapshotCount }, (_, index) => ({
    'snapshot-id': 1_000_000_000 + index,
    'sequence-number': index + 1,
    'timestamp-ms': 1_790_000_000_000 + index,
    'manifest-list': `s3://fixture_bucket/gsc_v1/page_queries/metadata/snap-${1_000_000_000 + index}-1-00000000-0000-0000-0000-000000000000.avro`,
    'summary': {
      'operation': 'append',
      'added-records': '500',
      'total-records': String(6500 + index * 500),
      'lakehouse.append-id': `registered-host:${JSON.stringify(['historic', 2, 'gsc_v1', 1, `wave-${index}`, 'page_queries', 'web', '2025-07-01', request, index * 500])}`,
    },
    'schema-id': 0,
  }))
  return JSON.stringify({ 'metadata-location': 'memory://page_queries/1.json', 'config': {}, 'metadata': { 'format-version': 2, 'table-uuid': 'fixture', 'current-snapshot-id': 1_000_000_000 + snapshotCount - 1, snapshots } })
}

const ctx = Object.freeze({ type: 'rest', url: 'https://catalog.invalid', prefix: 'w', defaults: {}, overrides: {} }) as Parameters<typeof restCatalogLoadTable>[0]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('restCatalogLoadTable metadata parsing', () => {
  it('keeps 64-bit ids exact and retains a small multiple of the body size', async () => {
    const body = loadTableBody(8_000)
    expect(body.length).toBeGreaterThan(4_000_000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    gc()
    const before = process.memoryUsage().heapUsed
    const loaded = await restCatalogLoadTable(ctx, { namespace: 'gsc', table: 'pages' })
    gc()
    const retained = process.memoryUsage().heapUsed - before

    const expected = parseIcebird0830(body) as { 'metadata-location': string, 'config': object, 'metadata': unknown }
    expect(loaded).toEqual({ metadataLocation: expected['metadata-location'], metadata: expected.metadata, config: expected.config })
    expect(loaded.metadata.snapshots![7_999]!['snapshot-id']).toBe(6_000_000_000_000_000_000n + 7_999n * 7_919n)
    // JSON.parse retains about 2 times the body size here; the 0.8.30 parser about 6 times.
    expect(retained).toBeLessThan(body.length * 3)
  })

  it('retains a small multiple of the body size when strings carry many escapes', async () => {
    const body = escapedSummaryBody(1_000)
    expect(body.split('\\"').length).toBeGreaterThan(50_000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    gc()
    gc()
    const before = process.memoryUsage().heapUsed
    const loaded = await restCatalogLoadTable(ctx, { namespace: 'gsc_v1', table: 'page_queries' })
    gc()
    gc()
    const retained = process.memoryUsage().heapUsed - before

    const expected = parseIcebird0830(body) as { 'metadata-location': string, 'config': object, 'metadata': unknown }
    expect(loaded).toEqual({ metadataLocation: expected['metadata-location'], metadata: expected.metadata, config: expected.config })
    // Decoding each escape into a rope retained about 10 times the body size.
    expect(retained).toBeLessThan(body.length * 3)
  })

  it('decodes escapes that JSON.parse refuses as the 0.8.30 parser did', async () => {
    const body = '{"metadata": {"location": "a\\qb\\u00e9\\x", "raw": "tab\there", "mixed": "tab\t\\"q\\" \\u00e9\\z"}}'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const loaded = await restCatalogLoadTable(ctx, { namespace: 'gsc', table: 'pages' })
    expect(loaded.metadata).toEqual((parseIcebird0830(body) as { metadata: unknown }).metadata)
  })

  it('reads a short \\u escape past the closing quote as the 0.8.30 parser did', async () => {
    // The 0.8.30 parser always consumes four characters after \u, so here the
    // string ends at the second quote.
    const body = '{"metadata": {"key": "x\\u12"ab"}}'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const loaded = await restCatalogLoadTable(ctx, { namespace: 'gsc', table: 'pages' })
    expect(loaded.metadata).toEqual({ key: 'x\u0012b' })
    expect(loaded.metadata).toEqual((parseIcebird0830(body) as { metadata: unknown }).metadata)
  })
})
