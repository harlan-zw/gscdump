/**
 * Per-team R2 Data Catalog provisioning (ADR-0021 amendment 11) — a subpath
 * export, separate from the main entrypoint: it's cold/admin, needs the wider
 * Account API token, and must never be bundleable into the per-request
 * ingest Worker path.
 *
 * Consolidates nuxtseo's `provision-team-catalog.ts` CF-REST shape
 * (bucket create + CORS + catalog enable) with gscdump.com's
 * `team-catalog-provisioner.ts` maintenance half (compaction +
 * snapshot-expiration `maintenance-configs`, plus the `credential` set a
 * catalog needs before either maintenance job can actually run) into ONE
 * routine with three modes:
 *
 *  - `adoptCatalog`   — a partner (nuxtseo) already has a ref for this team;
 *                       validate + return it, never provision a parallel one.
 *  - `selfProvision`  — this account creates the bucket + catalog from
 *                       scratch (the CF-REST side effects).
 *  - `suppliedCatalog`— an external caller hands in R2 details directly
 *                       ("provision a gscdump account with the R2 details and
 *                       it just works") — a pure validation/passthrough, no
 *                       CF calls.
 *
 * DB-agnostic by design: this module has no persistence of its own — the
 * caller reads/writes its own `teams`/`team_catalogs`-shaped row. The
 * Catalog Site Id allocator lives alongside it in `./allocator`.
 */

export type { AllocateCatalogSiteIdOptions, AllocateCatalogSiteIdResult } from './allocator'
export { allocateCatalogSiteId } from './allocator'

import type { PartitionKeyEncoding } from '../schema'

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

/** Compaction output target size — the R2 Data Catalog default/recommended value. */
const COMPACTION_TARGET_SIZE_MB = '128'
/**
 * Snapshot expiry — without it the snapshot log in `metadata.json` grows one
 * entry per commit forever, and every cold read pays for walking the whole
 * log. Reads always use the LATEST snapshot, so expiring superseded versions
 * is safe.
 */
const SNAPSHOT_MIN_SNAPSHOTS_TO_KEEP = 10
const SNAPSHOT_MAX_AGE = '3d'

export interface CloudflareProvisionCreds {
  accountId: string
  /** Account-scoped management API token (bucket CRUD). */
  apiToken: string
  /** R2-Data-Catalog-scoped token (enable / maintenance-configs / credential). */
  catalogToken: string
  /**
   * A dedicated R2 *Object Read & Write* token the catalog stores for its OWN
   * maintenance runs. Compaction is configured but INERT without this — a
   * catalog with `credential_status:absent` reports `enabled` but never
   * compacts. Optional (best-effort): omitted, maintenance stays configured
   * but dormant.
   */
  compactionCredentialToken?: string
}

export interface ProvisionedCatalogRef {
  catalogUri: string
  warehouse: string
  bucket: string
  namespace: string
}

interface CfResponse {
  success: boolean
  errors?: { code: number, message: string }[]
}

/** "already exists" / "already enabled" CF responses are success on re-run. */
function isBenignConflict(status: number, body: string): boolean {
  if (status === 409)
    return true
  const lower = body.toLowerCase()
  return lower.includes('already exist') || lower.includes('already enabled') || lower.includes('already in use')
}

async function cfPost(
  fetchImpl: typeof fetch,
  accountId: string,
  token: string,
  path: string,
  body: unknown,
): Promise<void> {
  const res = await fetchImpl(`${CF_API_BASE}/accounts/${accountId}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (res.ok) {
    const json = (text ? (JSON.parse(text) as CfResponse) : { success: true })
    if (json.success === false && !isBenignConflict(res.status, text))
      throw new Error(`CF POST ${path} failed: ${json.errors?.map(e => e.message).join(', ') || text}`)
    return
  }
  if (isBenignConflict(res.status, text))
    return
  throw new Error(`CF POST ${path} failed: ${res.status} ${text}`)
}

async function putBucketCors(
  fetchImpl: typeof fetch,
  accountId: string,
  apiToken: string,
  bucket: string,
  origins: readonly string[],
): Promise<void> {
  const res = await fetchImpl(`${CF_API_BASE}/accounts/${accountId}/r2/buckets/${bucket}/cors`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      rules: [{
        allowed: { origins, methods: ['GET', 'HEAD'], headers: ['range', 'content-type'] },
        exposeHeaders: ['content-range', 'content-length', 'accept-ranges', 'etag'],
        maxAgeSeconds: 86_400,
      }],
    }),
  })
  if (res.ok)
    return
  const text = await res.text().catch(() => '')
  if (isBenignConflict(res.status, text))
    return
  throw new Error(`CF PUT /r2/buckets/${bucket}/cors failed: ${res.status} ${text}`)
}

/**
 * Enable compaction + snapshot expiry via ONE `maintenance-configs` upsert.
 * BEST-EFFORT: a failure is logged, never thrown — maintenance is a
 * cost/performance optimization, not a correctness gate.
 */
async function enableMaintenance(
  fetchImpl: typeof fetch,
  accountId: string,
  catalogToken: string,
  bucket: string,
  onWarn: (message: string) => void,
): Promise<void> {
  await cfPost(fetchImpl, accountId, catalogToken, `r2-catalog/${bucket}/maintenance-configs`, {
    compaction: { state: 'enabled', target_size_mb: COMPACTION_TARGET_SIZE_MB },
    snapshot_expiration: { state: 'enabled', min_snapshots_to_keep: SNAPSHOT_MIN_SNAPSHOTS_TO_KEEP, max_snapshot_age: SNAPSHOT_MAX_AGE },
  }).catch((err: unknown) => {
    onWarn(`[lakehouse-provisioning] maintenance-configs failed for ${bucket} — catalog usable but maintenance stays off: ${err instanceof Error ? err.message : String(err)}`)
  })
}

/**
 * Set the catalog's OWN maintenance credential. Must precede
 * {@link enableMaintenance} — compaction enable requires the credential to
 * already be present. BEST-EFFORT + idempotent (re-POSTing rotates it).
 */
async function ensureCredential(
  fetchImpl: typeof fetch,
  accountId: string,
  catalogToken: string,
  credentialToken: string,
  bucket: string,
  onWarn: (message: string) => void,
): Promise<void> {
  await cfPost(fetchImpl, accountId, catalogToken, `r2-catalog/${bucket}/credential`, { token: credentialToken })
    .catch((err: unknown) => {
      onWarn(`[lakehouse-provisioning] credential-set failed for ${bucket} — compaction stays inert (credential absent): ${err instanceof Error ? err.message : String(err)}`)
    })
}

export interface SelfProvisionOptions {
  creds: CloudflareProvisionCreds
  bucket: string
  namespace: string
  /** Browser-read CORS origins for direct S3 presigned reads (DuckDB-WASM). */
  corsOrigins: readonly string[]
  /** Injectable fetch — defaults to the global. */
  fetch?: typeof fetch
  /** Injectable warn sink for best-effort maintenance failures. Defaults to `console.warn`. */
  onWarn?: (message: string) => void
}

/**
 * Self-provision (idempotently) a team's R2 bucket + Data Catalog: create the
 * bucket, set browser-read CORS, enable the catalog, set the maintenance
 * credential, then enable compaction + snapshot expiry. Every step treats
 * "already exists/enabled" as success. Table creation is NOT this routine's
 * job — callers create their own dataset tables via `dataset.createTable`
 * once the namespace exists.
 */
export async function selfProvisionCatalog(opts: SelfProvisionOptions): Promise<ProvisionedCatalogRef> {
  const { creds, bucket, namespace, corsOrigins } = opts
  const fetchImpl = opts.fetch ?? fetch
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m))

  await cfPost(fetchImpl, creds.accountId, creds.apiToken, 'r2/buckets', { name: bucket })
  await putBucketCors(fetchImpl, creds.accountId, creds.apiToken, bucket, corsOrigins)
  await cfPost(fetchImpl, creds.accountId, creds.catalogToken, `r2-catalog/${bucket}/enable`, {})

  // Credential MUST be set before enabling compaction (catalog-level enable
  // and per-table enable both require the warehouse credential present first).
  if (creds.compactionCredentialToken)
    await ensureCredential(fetchImpl, creds.accountId, creds.catalogToken, creds.compactionCredentialToken, bucket, onWarn)
  await enableMaintenance(fetchImpl, creds.accountId, creds.catalogToken, bucket, onWarn)

  return {
    catalogUri: `https://catalog.cloudflarestorage.com/${creds.accountId}/${bucket}`,
    warehouse: `${creds.accountId}_${bucket}`,
    bucket,
    namespace,
  }
}

/** A remote catalog ref as reported by a partner's catalog API (gscdump's `/teams/:id/catalog`, e.g.). */
export interface RemoteCatalogRef {
  catalogUri: string | null
  warehouse: string | null
  bucket: string | null
  namespace?: string | null
  keyEncoding?: PartitionKeyEncoding | null
  provisioningState?: string | null
}

export type AdoptCatalogResult
  = | { _tag: 'adopted', ref: ProvisionedCatalogRef }
    | { _tag: 'no-catalog' }
    | { _tag: 'rejected', reason: 'not-ready' | 'key-encoding', detail: string }

export interface AdoptCatalogOptions {
  /** Identity partitions this consumer writes require this encoding (default `'int'`). */
  requireEncoding?: PartitionKeyEncoding
}

/**
 * ADOPT mode: validate a partner-reported catalog ref rather than provisioning
 * a second one. Rejections are deliberate hard gates, not fallbacks:
 *  - `key-encoding` — writers key identity unconditionally in one encoding;
 *    adopting a mismatched catalog would poison it (partition type mismatch).
 *  - `not-ready` — the partner owns that catalog's lifecycle; provisioning a
 *    parallel one would fork the team's lake.
 */
export function adoptCatalog(remote: RemoteCatalogRef | null, opts: AdoptCatalogOptions = {}): AdoptCatalogResult {
  if (!remote || !remote.catalogUri || !remote.warehouse || !remote.bucket)
    return { _tag: 'no-catalog' }
  const requireEncoding = opts.requireEncoding ?? 'int'
  if (remote.keyEncoding && remote.keyEncoding !== requireEncoding)
    return { _tag: 'rejected', reason: 'key-encoding', detail: `catalog is ${remote.keyEncoding}-encoded; writers require ${requireEncoding}` }
  if (remote.provisioningState && remote.provisioningState !== 'ready')
    return { _tag: 'rejected', reason: 'not-ready', detail: `provisioningState=${remote.provisioningState}` }
  return {
    _tag: 'adopted',
    ref: { catalogUri: remote.catalogUri, warehouse: remote.warehouse, bucket: remote.bucket, namespace: remote.namespace ?? 'default' },
  }
}

/**
 * SUPPLIED-CATALOG mode: an external caller hands in R2 details directly
 * ("provision a gscdump account with the R2 details and it just works") — a
 * pure validation/passthrough, no CF calls, no persistence.
 */
export function suppliedCatalog(ref: ProvisionedCatalogRef): ProvisionedCatalogRef {
  if (!ref.catalogUri || !ref.warehouse || !ref.bucket)
    throw new Error('suppliedCatalog: catalogUri, warehouse and bucket are all required')
  return ref
}
