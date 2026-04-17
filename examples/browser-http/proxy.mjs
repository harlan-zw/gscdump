#!/usr/bin/env node
// Demo-only proxy between the browser and R2. Mimics what a production
// Cloudflare Worker would do: signs + forwards object reads, builds a manifest
// by listing the user's prefix. Keeps the R2 secret keys off the browser.
//
// Routes:
//   GET /                       → index.html
//   GET /bundle.mjs             → browser bundle
//   GET /browser-entry.mjs      → (unused, but lint-ignored)
//   GET /manifest.json          → built live from R2 LIST
//   GET /u_<id>/<site>/<...>    → signed R2 GET, streamed back
//
// Run from repo root:
//   node examples/browser-http/proxy.mjs
//
// Reads these from .env:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   GSCDUMP_USER_ID, GSCDUMP_SITE_ID (manifest prefix filter)
//   PORT (default 8081)

import { createReadStream, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { AwsClient } from 'aws4fetch'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// --- .env loader (tiny, intentional; avoids a dep) -----------------------
async function loadEnv(p) {
  try {
    const raw = await readFile(p, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^(\w+)=(.*)$/.exec(line.trim())
      if (!m)
        continue
      const key = m[1]
      const val = m[2].replace(/^['"]|['"]$/g, '')
      if (!(key in process.env))
        process.env[key] = val
    }
  }
  catch {}
}
await loadEnv(path.join(DIR, '..', '..', '.env'))

const requiredEnv = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'GSCDUMP_USER_ID',
  'GSCDUMP_SITE_ID',
]
const missing = requiredEnv.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(', ')}`)
  process.exit(1)
}

const PORT = Number(process.env.PORT ?? 8081)
const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  GSCDUMP_USER_ID,
  GSCDUMP_SITE_ID,
} = process.env

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
const aws = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
})

// --- R2 helpers ---------------------------------------------------------
async function* listAllKeys(prefix) {
  let continuationToken
  while (true) {
    const u = new URL(`/${R2_BUCKET}`, R2_ENDPOINT)
    u.searchParams.set('list-type', '2')
    u.searchParams.set('prefix', prefix)
    if (continuationToken)
      u.searchParams.set('continuation-token', continuationToken)
    const signed = await aws.sign(new Request(u, { method: 'GET' }))
    const res = await fetch(signed)
    if (!res.ok)
      throw new Error(`r2 list failed ${res.status} ${await res.text()}`)
    const xml = await res.text()
    // Parse <Contents><Key>...</Key><Size>...</Size><LastModified>...</LastModified></Contents>
    const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []
    for (const c of contents) {
      const key = /<Key>([^<]+)<\/Key>/.exec(c)?.[1]
      const size = Number(/<Size>([^<]+)<\/Size>/.exec(c)?.[1] ?? '0')
      const lastModified = /<LastModified>([^<]+)<\/LastModified>/.exec(c)?.[1]
      if (key)
        yield { key, size, lastModified }
    }
    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
    if (!isTruncated)
      return
    continuationToken = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
    if (!continuationToken)
      return
  }
}

// objectKey shape: u_<userId>/<siteId>/<table>/daily/<YYYY-MM-DD>__v<ts>.parquet
// We rebuild ManifestEntry from that — no siteId encoding on gscdump.com side.
function parseKey(key) {
  const m = /^u_([^/]+)\/([^/]+)\/([^/]+)\/(daily|monthly)\/([^/]+)__v(\d+)\.parquet$/.exec(key)
  if (!m)
    return null
  return {
    userId: m[1],
    siteId: m[2],
    table: m[3],
    partition: `${m[4]}/${m[5]}`,
    version: Number(m[6]),
  }
}

async function buildManifest() {
  const prefix = `u_${GSCDUMP_USER_ID}/${GSCDUMP_SITE_ID}/`
  // Dedupe: keep only the newest version per (table, partition). R2 LIST
  // surfaces every historical write; without a real manifest in D1 we can't
  // mark superseded entries retired, so the latest-wins rule here is a
  // pragmatic stand-in. Cuts file count massively on re-synced days and
  // prevents double-counting via read_parquet's union_by_name.
  const latestByPartition = new Map()
  for await (const o of listAllKeys(prefix)) {
    const parsed = parseKey(o.key)
    if (!parsed)
      continue
    const key = `${parsed.table}|${parsed.partition}`
    const prior = latestByPartition.get(key)
    if (!prior || parsed.version > prior.version)
      latestByPartition.set(key, { ...parsed, objectKey: o.key, bytes: o.size })
  }
  const entries = [...latestByPartition.values()].map(p => ({
    userId: p.userId,
    siteId: p.siteId,
    table: p.table,
    partition: p.partition,
    objectKey: p.objectKey,
    rowCount: 0, // unknown from LIST alone; analyzers don't rely on rowCount
    bytes: p.bytes,
    createdAt: p.version,
  }))
  return { snapshot: { version: 1, entries, watermarks: [] }, count: entries.length }
}

// --- server --------------------------------------------------------------
let manifestCache = null // { fetchedAt, promise }

async function getManifest() {
  const now = Date.now()
  if (manifestCache && now - manifestCache.fetchedAt < 30_000)
    return manifestCache.promise
  manifestCache = { fetchedAt: now, promise: buildManifest().then(r => r.snapshot) }
  return manifestCache.promise
}

const STATIC = {
  '/': path.join(DIR, 'index.html'),
  '/index.html': path.join(DIR, 'index.html'),
  '/bundle.mjs': path.join(DIR, 'bundle.mjs'),
  '/browser-entry.mjs': path.join(DIR, 'browser-entry.mjs'),
  '/snapshot.duckdb': path.join(DIR, 'snapshot.duckdb'),
}
const SNAPSHOTS_DIR = path.join(DIR, '_snapshots')

function serveStatic(res, file, contentType, rangeHeader) {
  try {
    const s = statSync(file)
    if (rangeHeader) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Number(m[2]) : s.size - 1
        const len = end - start + 1
        res.writeHead(206, {
          'content-type': contentType,
          'content-length': String(len),
          'content-range': `bytes ${start}-${end}/${s.size}`,
          'accept-ranges': 'bytes',
        })
        createReadStream(file, { start, end }).pipe(res)
        return
      }
    }
    res.writeHead(200, { 'content-type': contentType, 'content-length': String(s.size), 'accept-ranges': 'bytes' })
    createReadStream(file).pipe(res)
  }
  catch {
    res.writeHead(404).end()
  }
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', `http://x`)

    // Static
    if (STATIC[pathname]) {
      const ext = path.extname(STATIC[pathname])
      const ct = ext === '.html' ? 'text/html' : ext === '.mjs' || ext === '.js' ? 'text/javascript' : ext === '.duckdb' ? 'application/vnd.duckdb' : 'application/octet-stream'
      serveStatic(res, STATIC[pathname], ct, req.headers.range)
      return
    }

    // Hot/cold snapshot files + index
    if (pathname.startsWith('/_snapshots/')) {
      const file = path.join(SNAPSHOTS_DIR, pathname.slice('/_snapshots/'.length))
      if (!file.startsWith(`${SNAPSHOTS_DIR}/`)) { res.writeHead(403).end(); return }
      const ct = file.endsWith('.json') ? 'application/json' : 'application/vnd.duckdb'
      serveStatic(res, file, ct, req.headers.range)
      return
    }

    // Manifest
    if (pathname === '/manifest.json') {
      const m = await getManifest()
      const body = JSON.stringify(m)
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'max-age=15',
      })
      res.end(body)
      return
    }

    // R2 object passthrough
    if (pathname.startsWith('/u_')) {
      const key = decodeURIComponent(pathname.slice(1))
      const u = new URL(`/${R2_BUCKET}/${key}`, R2_ENDPOINT)
      const signed = await aws.sign(new Request(u, {
        method: 'GET',
        headers: req.headers.range ? { range: req.headers.range } : undefined,
      }))
      const upstream = await fetch(signed)
      // Parquet bodies are immutable (content-addressed by __v<ts> in the
      // key). Long-cache them so the browser HTTP cache can serve repeat
      // range requests. In production this lives on the R2/Worker edge.
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-length': upstream.headers.get('content-length') ?? '',
        'content-range': upstream.headers.get('content-range') ?? '',
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
      })
      if (!upstream.body) { res.end(); return }
      // Node 18+: Response body is a web ReadableStream
      const reader = upstream.body.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done)
          break
        res.write(value)
      }
      res.end()
      return
    }

    res.writeHead(404).end()
  }
  catch (err) {
    console.error(err)
    res.writeHead(500).end(String(err?.message ?? err))
  }
})

server.listen(PORT, () => {
  console.log(`\n  gscdump browser-http proxy`)
  console.log(`  → http://localhost:${PORT}/`)
  console.log(`  → user=${GSCDUMP_USER_ID} site=${GSCDUMP_SITE_ID}`)
  console.log(`  → bucket=${R2_BUCKET} @ ${R2_ENDPOINT}\n`)
})
