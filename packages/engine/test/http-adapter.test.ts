// Integration test: run the engine through HTTP adapters against a tiny
// local static server. Seeds data via the filesystem engine, snapshots the
// manifest, serves both over HTTP, then queries via the http adapters and
// confirms results match.

import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { encodeSiteId } from 'gscdump/tenant'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '../src/adapters/filesystem'
import {
  createHttpDataSource,
  createHttpManifestStore,
} from '../src/adapters/http'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '../src/index'

const USER = 'u1'
const SITE = 'sc-domain:example.com'
const siteId = encodeSiteId(SITE)

afterAll(() => resetNodeDuckDB())

function startStaticServer(root: string): Promise<{ baseUrl: string, close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const abs = path.resolve(root, key)
      if (!abs.startsWith(`${path.resolve(root)}/`) && abs !== path.resolve(root)) {
        res.writeHead(403).end()
        return
      }
      const s = await stat(abs).catch(() => null)
      if (!s || !s.isFile()) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-length': String(s.size),
        'content-type': abs.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      })
      createReadStream(abs).pipe(res)
    }
    catch {
      res.writeHead(500).end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

describe('http adapters', () => {
  let dir: string
  let server: { baseUrl: string, close: () => Promise<void> }

  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(path.join(os.tmpdir(), 'gscdump-http-'))
  })

  afterEach(async () => {
    if (server)
      await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('engine.runSQL resolves object keys via dataSource.uri → httpfs URL', async () => {
    // Seed via filesystem engine
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const fsEngine = createStorageEngine({
      dataSource: createFilesystemDataSource({ rootDir: dir }),
      manifestStore: createFilesystemManifestStore({ path: path.join(dir, 'manifest.json') }),
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })
    await fsEngine.writeDay(
      { userId: USER, siteId, table: 'pages', date: '2026-04-10' },
      [
        { url: 'https://example.com/a', date: '2026-04-10', clicks: 5, impressions: 50, sum_position: 150 },
        { url: 'https://example.com/b', date: '2026-04-10', clicks: 3, impressions: 30, sum_position: 90 },
      ],
    )

    // Publish the manifest to a predictable key for HTTP service
    await copyFile(path.join(dir, 'manifest.json'), path.join(dir, 'manifest-public.json'))

    server = await startStaticServer(dir)

    // Build a read-only engine wired to HTTP adapters.
    // useDuckDBHttpfs=false because our node-blocking DuckDB-WASM doesn't
    // load httpfs; the executor falls back to dataSource.read() → HTTP fetch
    // → registerFileBuffer. In the browser, leave the default (true) so
    // DuckDB's httpfs streams bytes directly.
    const httpEngine = createStorageEngine({
      dataSource: createHttpDataSource({ baseUrl: server.baseUrl, useDuckDBHttpfs: false }),
      manifestStore: createHttpManifestStore({ manifestUrl: `${server.baseUrl}/manifest-public.json` }),
      codec: createDuckDBCodec(factory), // unused on reads
      executor: createDuckDBExecutor(factory),
    })

    const result = await httpEngine.runSQL({
      ctx: { userId: USER, siteId },
      fileSets: { FILES: { table: 'pages' } },
      table: 'pages',
      sql: 'SELECT url, clicks FROM read_parquet({{FILES}}, union_by_name = true) ORDER BY url',
    })
    expect(result.rows).toEqual([
      { url: '/a', clicks: 5 },
      { url: '/b', clicks: 3 },
    ])
  })

  it('manifest cache is one fetch, listLive filters correctly', async () => {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const fsEngine = createStorageEngine({
      dataSource: createFilesystemDataSource({ rootDir: dir }),
      manifestStore: createFilesystemManifestStore({ path: path.join(dir, 'manifest.json') }),
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })
    await fsEngine.writeDay(
      { userId: USER, siteId, table: 'pages', date: '2026-04-10' },
      [{ url: '/p', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 30 }],
    )
    await fsEngine.writeDay(
      { userId: USER, siteId, table: 'keywords', date: '2026-04-10' },
      [{ query: 'q', date: '2026-04-10', clicks: 2, impressions: 20, sum_position: 60 }],
    )

    await copyFile(path.join(dir, 'manifest.json'), path.join(dir, 'manifest-public.json'))

    let fetchCount = 0
    const countingFetch: typeof fetch = async (...args) => {
      fetchCount += 1
      return fetch(...args as Parameters<typeof fetch>)
    }
    server = await startStaticServer(dir)
    const store = createHttpManifestStore({
      manifestUrl: `${server.baseUrl}/manifest-public.json`,
      fetchImpl: countingFetch,
    })

    const pages = await store.listLive({ userId: USER, siteId, table: 'pages' })
    const keywords = await store.listLive({ userId: USER, siteId, table: 'keywords' })
    expect(pages).toHaveLength(1)
    expect(keywords).toHaveLength(1)
    expect(fetchCount).toBe(1)

    // writes throw
    await expect(store.registerVersion({
      userId: USER,
      siteId,
      table: 'pages',
      partition: 'daily/2026-04-10',
      objectKey: 'fake',
      rowCount: 0,
      bytes: 0,
      createdAt: 0,
    })).rejects.toThrow(/read-only/)
  })

  it('dataSource.read() fetches bytes over HTTP (fallback path for wasm-only runtimes)', async () => {
    // Pre-write a small parquet via filesystem engine
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const fsEngine = createStorageEngine({
      dataSource: createFilesystemDataSource({ rootDir: dir }),
      manifestStore: createFilesystemManifestStore({ path: path.join(dir, 'manifest.json') }),
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })
    await fsEngine.writeDay(
      { userId: USER, siteId, table: 'pages', date: '2026-04-10' },
      [{ url: '/x', date: '2026-04-10', clicks: 1, impressions: 1, sum_position: 1 }],
    )
    const live = await fsEngine.listLive({ userId: USER, table: 'pages' })
    expect(live).toHaveLength(1)
    const key = live[0].objectKey
    const localBytes = await readFile(path.join(dir, key))

    server = await startStaticServer(dir)
    const ds = createHttpDataSource({ baseUrl: server.baseUrl })
    const fetched = await ds.read(key)
    expect(Buffer.from(fetched).equals(localBytes)).toBe(true)

    const head = await ds.head!(key)
    expect(head?.bytes).toBe(localBytes.byteLength)
  })
})
