/**
 * R2 conditional-PUT production validation harness.
 *
 * Roadmap item C6: before first production rollout, drive a real R2 bucket
 * with N-parallel `setSyncState` callers and measure how hard the
 * `(siteId, table)` shard scheme bumps into R2's documented
 * 1-write/sec/key ceiling. If shared-scope contention is too high, the
 * manifest store should shard finer to `(siteId, table, searchType)`.
 *
 * When to run:
 *   - Before enabling the R2 manifest store in production.
 *   - When changing the shard key shape.
 *   - After any R2 consistency/latency incident upstream at Cloudflare.
 *
 * How to run:
 *   cd packages/engine
 *   export R2_ENDPOINT=https://<accountId>.r2.cloudflarestorage.com
 *   export R2_BUCKET=<bucket>
 *   export R2_ACCESS_KEY_ID=<key>
 *   export R2_SECRET_ACCESS_KEY=<secret>
 *   pnpm r2-harness -- --parallelism 50 --iterations 100 --scope shared
 *   pnpm r2-harness -- --parallelism 50 --iterations 100 --scope sharded
 *   pnpm r2-harness -- --parallelism 50 --iterations 100 --scope shared --cleanup
 *
 * The script writes under the tenant prefix
 * `u_harness-<timestamp>/manifest/...` so concurrent runs do not collide.
 * Pass `--cleanup` to purge the harness tenant at the end.
 *
 * NOTE: This is a manual ops script. It is intentionally not covered by
 * the unit test suite — it only works against a real R2 bucket and costs
 * real PUT operations.
 */

import type { GscSearchType } from '@gscdump/contracts/search-types'
import type {
  R2ManifestBucketLike,
  R2ManifestEvent,
} from '../src/adapters/r2-manifest'
import type { TableName } from '../src/storage'
import process from 'node:process'
import { GSC_SEARCH_TYPES } from '@gscdump/contracts/search-types'
import { AwsClient } from 'aws4fetch'
import { createR2ManifestStore } from '../src/adapters/r2-manifest'

// ---------- CLI parsing ----------

interface CliArgs {
  parallelism: number
  iterations: number
  scope: 'shared' | 'sharded'
  cleanup: boolean
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (!tok.startsWith('--'))
      continue
    const key = tok.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    }
    else {
      args[key] = next
      i++
    }
  }
  const parallelism = Number(args.parallelism ?? 50)
  const iterations = Number(args.iterations ?? 100)
  const scopeRaw = (args.scope ?? 'shared') as string
  if (scopeRaw !== 'shared' && scopeRaw !== 'sharded')
    throw new Error(`--scope must be 'shared' or 'sharded', got '${scopeRaw}'`)
  if (!Number.isFinite(parallelism) || parallelism < 1)
    throw new Error(`--parallelism must be a positive integer, got '${args.parallelism}'`)
  if (!Number.isFinite(iterations) || iterations < 1)
    throw new Error(`--iterations must be a positive integer, got '${args.iterations}'`)
  return {
    parallelism,
    iterations,
    scope: scopeRaw,
    cleanup: args.cleanup === true,
  }
}

// ---------- Env ----------

interface R2Env {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

function readEnv(): R2Env {
  const endpoint = process.env.R2_ENDPOINT
  const bucket = process.env.R2_BUCKET
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const missing: string[] = []
  if (!endpoint)
    missing.push('R2_ENDPOINT')
  if (!bucket)
    missing.push('R2_BUCKET')
  if (!accessKeyId)
    missing.push('R2_ACCESS_KEY_ID')
  if (!secretAccessKey)
    missing.push('R2_SECRET_ACCESS_KEY')
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. `
      + `Set all four before running the harness.`,
    )
  }
  return {
    endpoint: endpoint!.replace(/\/$/, ''),
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
  }
}

// ---------- Real R2 bucket adapter over the S3-compat API ----------

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

interface S3ListContent {
  key: string
}

const CONTENTS_RE = /<Contents>[\s\S]*?<\/Contents>/g
const KEY_RE = /<Key>([^<]+)<\/Key>/
const NEXT_TOKEN_RE = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
const IS_TRUNCATED_RE = /<IsTruncated>true<\/IsTruncated>/

function parseListXml(xml: string): { objects: S3ListContent[], nextToken?: string, truncated: boolean } {
  const objects: S3ListContent[] = []
  for (const chunk of xml.match(CONTENTS_RE) ?? []) {
    const key = KEY_RE.exec(chunk)?.[1]
    if (key)
      objects.push({ key })
  }
  const nextToken = NEXT_TOKEN_RE.exec(xml)?.[1]
  const truncated = IS_TRUNCATED_RE.test(xml)
  return { objects, nextToken, truncated }
}

function createS3Bucket(env: R2Env): R2ManifestBucketLike {
  const aws = new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  const base = `${env.endpoint}/${env.bucket}`

  async function get(key: string) {
    const res = await fetch(await aws.sign(`${base}/${encodeKey(key)}`))
    if (res.status === 404)
      return null
    if (!res.ok)
      throw new Error(`r2 GET ${key} failed ${res.status}: ${await res.text()}`)
    const etag = (res.headers.get('etag') ?? '').replace(/"/g, '')
    const text = await res.text()
    return { etag, text: async () => text }
  }

  async function put(
    key: string,
    bytes: string | Uint8Array,
    options?: { onlyIf?: { etagMatches?: string, etagDoesNotMatch?: string } },
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
    if (options?.onlyIf?.etagMatches !== undefined)
      headers['if-match'] = `"${options.onlyIf.etagMatches}"`
    if (options?.onlyIf?.etagDoesNotMatch === '*')
      headers['if-none-match'] = '*'
    const body = typeof bytes === 'string' ? bytes : new Uint8Array(bytes)
    const signed = await aws.sign(new Request(`${base}/${encodeKey(key)}`, {
      method: 'PUT',
      headers,
      body,
    }))
    const res = await fetch(signed)
    // 412 Precondition Failed → CAS rejection. Returning null tells the
    // manifest store to re-read HEAD and retry.
    if (res.status === 412)
      return null
    if (!res.ok)
      throw new Error(`r2 PUT ${key} failed ${res.status}: ${await res.text()}`)
    const etag = (res.headers.get('etag') ?? '').replace(/"/g, '')
    return { etag }
  }

  async function list(options?: { prefix?: string, cursor?: string, limit?: number }) {
    const u = new URL(`${env.endpoint}/${env.bucket}`)
    u.searchParams.set('list-type', '2')
    if (options?.prefix)
      u.searchParams.set('prefix', options.prefix)
    if (options?.cursor)
      u.searchParams.set('continuation-token', options.cursor)
    if (options?.limit)
      u.searchParams.set('max-keys', String(options.limit))
    const signed = await aws.sign(new Request(u, { method: 'GET' }))
    const res = await fetch(signed)
    if (!res.ok)
      throw new Error(`r2 LIST failed ${res.status}: ${await res.text()}`)
    const parsed = parseListXml(await res.text())
    return {
      objects: parsed.objects.map(o => ({ key: o.key })),
      truncated: parsed.truncated,
      cursor: parsed.nextToken,
    }
  }

  async function del(keys: string | string[]) {
    const batch = typeof keys === 'string' ? [keys] : keys
    // S3 bulk delete needs a signed POST with XML body. For harness cleanup,
    // issuing N parallel DELETEs is simpler and fine — the harness key
    // count is small.
    await Promise.all(batch.map(async (k) => {
      const signed = await aws.sign(new Request(`${base}/${encodeKey(k)}`, { method: 'DELETE' }))
      const res = await fetch(signed)
      if (!res.ok && res.status !== 404)
        throw new Error(`r2 DELETE ${k} failed ${res.status}: ${await res.text()}`)
    }))
  }

  return { get, put, list, delete: del }
}

// ---------- Metrics ----------

interface Percentiles {
  p50: number
  p95: number
  p99: number
}

function percentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0)
    return { p50: 0, p95: 0, p99: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  function at(q: number): number {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
    return sorted[idx]!
  }
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}

interface RunResult {
  scope: 'shared' | 'sharded'
  totalOps: number
  wallMs: number
  opsPerSec: number
  rejections: number
  rejectionRate: number
  latency: Percentiles
}

// ---------- Harness run ----------

const TABLES: TableName[] = ['pages', 'keywords']
const SEARCH_TYPES = Object.values(GSC_SEARCH_TYPES)
const SITES = ['harness-site-a', 'harness-site-b']

interface WorkUnit {
  siteId: string
  table: TableName
  searchType: GscSearchType
  date: string
}

function pickShardedUnit(callerIdx: number, iter: number): WorkUnit {
  // Spread writers across (siteId, table, searchType) combos so each shard
  // sees roughly parallelism/(sites*tables*types) concurrent callers.
  const idx = callerIdx * 31 + iter
  return {
    siteId: SITES[idx % SITES.length]!,
    table: TABLES[(idx >> 1) % TABLES.length]!,
    searchType: SEARCH_TYPES[(idx >> 2) % SEARCH_TYPES.length]!,
    date: '2026-04-10',
  }
}

function pickSharedUnit(_callerIdx: number, _iter: number): WorkUnit {
  // Every caller hits the exact same (siteId, table, date, searchType).
  // This is the worst case for R2 CAS contention: all writes target
  // one HEAD key.
  return {
    siteId: SITES[0]!,
    table: TABLES[0]!,
    searchType: 'web',
    date: '2026-04-10',
  }
}

async function runScope(
  bucket: R2ManifestBucketLike,
  userId: string,
  args: CliArgs,
): Promise<RunResult> {
  let totalRejections = 0
  const onEvent = (ev: R2ManifestEvent): void => {
    if (ev.kind === 'cas-rejected')
      totalRejections++
  }
  const store = createR2ManifestStore({ bucket, userId, onEvent, maxRetries: 32 })

  const pick = args.scope === 'shared' ? pickSharedUnit : pickShardedUnit
  const latencies: number[] = []

  async function caller(callerIdx: number): Promise<void> {
    for (let i = 0; i < args.iterations; i++) {
      const unit = pick(callerIdx, i)
      const start = performance.now()
      await store.setSyncState(
        { userId, siteId: unit.siteId, table: unit.table, date: unit.date, searchType: unit.searchType },
        i % 2 === 0 ? 'inflight' : 'done',
        { at: Date.now() },
      )
      latencies.push(performance.now() - start)
    }
  }

  const wallStart = performance.now()
  await Promise.all(Array.from({ length: args.parallelism }, (_, i) => caller(i)))
  const wallMs = performance.now() - wallStart

  const totalOps = args.parallelism * args.iterations
  const rejectionRate = totalOps === 0 ? 0 : totalRejections / totalOps
  return {
    scope: args.scope,
    totalOps,
    wallMs,
    opsPerSec: totalOps / (wallMs / 1000),
    rejections: totalRejections,
    rejectionRate,
    latency: percentiles(latencies),
  }
}

function renderResult(r: RunResult): string {
  return [
    `scope=${r.scope}`,
    `ops=${r.totalOps}`,
    `wall=${r.wallMs.toFixed(0)}ms`,
    `throughput=${r.opsPerSec.toFixed(2)}ops/sec`,
    `rejections=${r.rejections} (${(r.rejectionRate * 100).toFixed(1)}%)`,
    `p50=${r.latency.p50.toFixed(0)}ms`,
    `p95=${r.latency.p95.toFixed(0)}ms`,
    `p99=${r.latency.p99.toFixed(0)}ms`,
  ].join('  ')
}

function recommend(r: RunResult): string {
  if (r.scope !== 'shared')
    return 'n/a (run with --scope shared to evaluate)'
  // Shared-scope key throughput: below ~1 op/sec/key or >10% rejections
  // means R2's per-key ceiling is the bottleneck; shard by searchType.
  const tooSlow = r.opsPerSec < 1
  const tooLossy = r.rejectionRate > 0.1
  if (tooSlow || tooLossy) {
    return [
      'SHARD.',
      tooSlow ? `throughput ${r.opsPerSec.toFixed(2)} ops/sec < 1 ops/sec/key` : '',
      tooLossy ? `rejection rate ${(r.rejectionRate * 100).toFixed(1)}% > 10%` : '',
      'Tighten shard key to (siteId, table, searchType).',
    ].filter(Boolean).join(' ')
  }
  return 'DO NOT SHARD. Shared-scope contention within tolerance.'
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = readEnv()
  const bucket = createS3Bucket(env)
  const userId = `harness-${Date.now()}`

  console.log(`R2 contention harness`)
  console.log(`  endpoint=${env.endpoint}`)
  console.log(`  bucket=${env.bucket}`)
  console.log(`  tenant=u_${userId}`)
  console.log(`  parallelism=${args.parallelism} iterations=${args.iterations} scope=${args.scope}`)
  console.log('')

  const result = await runScope(bucket, userId, args)

  console.log('RESULT')
  console.log(`  ${renderResult(result)}`)
  console.log('')
  console.log('RECOMMENDATION')
  console.log(`  ${recommend(result)}`)

  if (args.cleanup) {
    console.log('')
    console.log(`cleanup: purging tenant u_${userId}`)
    const store = createR2ManifestStore({ bucket, userId })
    const purged = await store.purgeTenant({ userId })
    console.log(`  purged entries=${purged.entriesRemoved} watermarks=${purged.watermarksRemoved} syncStates=${purged.syncStatesRemoved}`)
  }
  else {
    console.log('')
    console.log(`note: tenant u_${userId} left in bucket. Re-run with --cleanup to purge.`)
  }
}

main().catch((err) => {
  console.error('[r2-harness] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
