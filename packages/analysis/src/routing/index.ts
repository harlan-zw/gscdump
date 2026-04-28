// Single source of truth for "should the R2/DuckDB path participate for this
// user/site?". Every call site in write-hook, backfill, sync, and read paths
// must go through these functions.
//
// The layer used to read `migrationPhase` / `migrationReadFrom` directly off
// the host's user / user_site rows, which coupled it to gscdump.com's
// Drizzle schema. It now takes those fields as plain values; hosts read them
// off whatever row shape they use and pass them in.
//
// Precedence: site-level override > user-level default. A `null` site value
// inherits from the user-level value, so hosts can opt specific sites into
// R2 without flipping every site on that user.
//
// Phase lattice:
//   'd1'   — D1 only. No dual-write, no R2 reads.
//   'dual' — Writes hit both D1 and R2 (D1 is authoritative). Reads from D1.
//   'r2'   — Writes hit both D1 and R2. Reads from R2 (with D1 shadow).
//
// migrationReadFrom is a separate knob so we can keep dual-writing while
// flipping read path on/off during incident response.

export type MigrationPhase = 'd1' | 'dual' | 'r2'
export type MigrationReadFrom = 'd1' | 'r2'

export interface RoutingInputs {
  userPhase: MigrationPhase | string | null | undefined
  userReadFrom: MigrationReadFrom | string | null | undefined
  sitePhase?: MigrationPhase | string | null
  siteReadFrom?: MigrationReadFrom | string | null
}

// Structural env shape — only the routing flags this module reads.
// Decouples this package from `@gscdump/cloudflare`'s `AnalyticsEnv`, which
// is a superset. The full type structurally satisfies this one, so callers
// pass it directly.
export interface RoutingEnv {
  ANALYTICS_FORCE_D1?: string
  R2_READS_ENABLED?: string
}

function isPhase(v: unknown): v is MigrationPhase {
  return v === 'd1' || v === 'dual' || v === 'r2'
}

function isReadFrom(v: unknown): v is MigrationReadFrom {
  return v === 'd1' || v === 'r2'
}

export function resolvePhase(inputs: Pick<RoutingInputs, 'userPhase' | 'sitePhase'>): MigrationPhase {
  if (isPhase(inputs.sitePhase))
    return inputs.sitePhase
  if (isPhase(inputs.userPhase))
    return inputs.userPhase
  return 'd1'
}

export function resolveReadFrom(inputs: Pick<RoutingInputs, 'userReadFrom' | 'siteReadFrom'>): MigrationReadFrom {
  if (isReadFrom(inputs.siteReadFrom))
    return inputs.siteReadFrom
  if (isReadFrom(inputs.userReadFrom))
    return inputs.userReadFrom
  return 'd1'
}

export function forceD1(env: Pick<RoutingEnv, 'ANALYTICS_FORCE_D1'>): boolean {
  return env.ANALYTICS_FORCE_D1 === '1'
}

// Opt-in gate. Even if a site has migration_read_from='r2', reads stay on
// D1 unless this env flag is explicitly set. Introduced after the ducklings
// R2 httpfs incident (2026-04) so a stray UPDATE can't silently re-enable
// the broken path.
export function r2ReadsEnabled(env: Pick<RoutingEnv, 'R2_READS_ENABLED'>): boolean {
  return env.R2_READS_ENABLED === '1'
}

export function shouldDualWrite(
  inputs: RoutingInputs,
  env: Pick<RoutingEnv, 'ANALYTICS_FORCE_D1'>,
): boolean {
  if (forceD1(env))
    return false
  const phase = resolvePhase(inputs)
  return phase === 'dual' || phase === 'r2'
}

// Analytics tables that R2 owns once a site is fully on phase='r2'.
// sitemap_*, url_indexing_status, etc. stay on D1 regardless of phase —
// they aren't part of the R2/Parquet dataset.
export type AnalyticsTable = 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords'

const ANALYTICS_TABLES = new Set<AnalyticsTable>(['pages', 'keywords', 'countries', 'devices', 'page_keywords'])

export function isAnalyticsTable(table: string): table is AnalyticsTable {
  return ANALYTICS_TABLES.has(table as AnalyticsTable)
}

// Returns false ONLY when the resolved phase is 'r2' AND the table is one of
// the R2-owned analytics tables. All other writes (dual phase, sitemap,
// indexing, anything during forced-D1 mode) still go to D1.
export function shouldWriteToD1(
  inputs: RoutingInputs,
  env: Pick<RoutingEnv, 'ANALYTICS_FORCE_D1'>,
  table: string,
): boolean {
  if (forceD1(env))
    return true
  if (!isAnalyticsTable(table))
    return true
  const phase = resolvePhase(inputs)
  return phase !== 'r2'
}

export function shouldReadFromR2(
  inputs: RoutingInputs,
  env: Pick<RoutingEnv, 'ANALYTICS_FORCE_D1' | 'R2_READS_ENABLED'>,
): boolean {
  if (forceD1(env))
    return false
  if (!r2ReadsEnabled(env))
    return false
  const phase = resolvePhase(inputs)
  if (phase === 'd1')
    return false
  return resolveReadFrom(inputs) === 'r2'
}

// Invariant check for admin PATCH endpoints: reading from R2 requires the
// write path to have been active (phase !== 'd1'), otherwise the R2 object
// set is guaranteed empty.
export function isValidReadFromForPhase(phase: MigrationPhase, readFrom: MigrationReadFrom): boolean {
  if (readFrom === 'r2' && phase === 'd1')
    return false
  return true
}
