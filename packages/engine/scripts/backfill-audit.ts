/**
 * Backfill coverage audit.
 *
 * Roadmap item D5: before retiring the D1 analytics read path for a site,
 * confirm the R2 parquet dataset covers the same historical range D1 does.
 * Without this check, switching `readBackend: 'r2'` on a site could silently
 * drop months of history from the dashboard.
 *
 * Flow:
 *  1. Read parquet watermarks from a filesystem ManifestStore. Run against
 *     the gscdump.com parquet mirror (or a local copy of the R2 bucket) —
 *     the shape is identical, and keeping the script backend-neutral lets
 *     CI run it without R2 credentials.
 *  2. Read a D1-side range snapshot from a JSON file the operator exports
 *     from their D1 (gscdump.com's schema — not shipped here).
 *  3. Per `(user, site, table)` emit parquet range vs. D1 range + any gap.
 *
 * D1 snapshot format (JSON array):
 *   [{ userId, siteId, table, oldestDate, newestDate, daysPresent? }, ...]
 *
 * Example:
 *   cd packages/engine
 *   pnpm backfill-audit -- --root /data/analytics --d1-ranges ./d1-export.json
 *
 * Exit code is non-zero when any gap is detected, so the script plugs
 * into CI / release gates. Use `--report json` to machine-parse.
 */

import type { TableName, Watermark, WatermarkFilter } from '../src/storage'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { createFilesystemManifestStore } from '../src/adapters/filesystem'

interface D1Range {
  userId: string
  siteId: string
  table: TableName
  oldestDate: string
  newestDate: string
  daysPresent?: number
}

interface CliArgs {
  root: string
  d1Ranges: string
  report: 'text' | 'json'
  userId?: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (!tok.startsWith('--'))
      continue
    const key = tok.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
      continue
    }
    flags[key] = next
    i++
  }

  const root = typeof flags.root === 'string' ? flags.root : ''
  const d1Ranges = typeof flags['d1-ranges'] === 'string' ? flags['d1-ranges'] : ''
  const report: CliArgs['report'] = flags.report === 'json' ? 'json' : 'text'
  const userId = typeof flags.user === 'string' ? flags.user : undefined

  if (!root)
    throw new Error('--root <dir> is required (parquet manifest root)')
  if (!d1Ranges)
    throw new Error('--d1-ranges <file.json> is required')

  return { root, d1Ranges, report, userId }
}

interface AuditRow {
  userId: string
  siteId: string
  table: TableName
  parquetOldest: string | null
  parquetNewest: string | null
  d1Oldest: string
  d1Newest: string
  /** Days present on the D1 side — surfaces sparse coverage even within an identical range. */
  d1DaysPresent: number | null
  /** Parquet's oldest date when D1 reaches further back (inclusive), else null. */
  missingBefore: string | null
  /** D1's newest date when it extends beyond parquet (inclusive), else null. */
  missingAfter: string | null
  status: 'ok' | 'gap' | 'missing-parquet' | 'missing-d1'
}

function classify(row: Omit<AuditRow, 'status'>): AuditRow['status'] {
  if (!row.parquetOldest || !row.parquetNewest)
    return 'missing-parquet'
  if (!row.d1Oldest || !row.d1Newest)
    return 'missing-d1'
  if (row.missingBefore || row.missingAfter)
    return 'gap'
  return 'ok'
}

function compare(parquet: Watermark | undefined, d1: D1Range): AuditRow {
  const parquetOldest = parquet?.oldestDateSynced ?? null
  const parquetNewest = parquet?.newestDateSynced ?? null
  const missingBefore = parquetOldest && d1.oldestDate < parquetOldest ? parquetOldest : null
  const missingAfter = parquetNewest && d1.newestDate > parquetNewest ? d1.newestDate : null
  const base = {
    userId: d1.userId,
    siteId: d1.siteId,
    table: d1.table,
    parquetOldest,
    parquetNewest,
    d1Oldest: d1.oldestDate,
    d1Newest: d1.newestDate,
    d1DaysPresent: d1.daysPresent ?? null,
    missingBefore,
    missingAfter,
  }
  return { ...base, status: classify(base) }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const d1: D1Range[] = JSON.parse(readFileSync(args.d1Ranges, 'utf8')) as D1Range[]
  if (!Array.isArray(d1))
    throw new TypeError('--d1-ranges must parse to a JSON array')

  const store = createFilesystemManifestStore({ path: args.root })

  const rows: AuditRow[] = []
  for (const entry of d1) {
    if (args.userId && entry.userId !== args.userId)
      continue
    const filter: WatermarkFilter = { userId: entry.userId, siteId: entry.siteId, table: entry.table }
    const parquet = await store.getWatermarks(filter)
    const match = parquet.find(w => w.siteId === entry.siteId && w.table === entry.table)
    rows.push(compare(match, entry))
  }

  const gaps = rows.filter(r => r.status !== 'ok')

  if (args.report === 'json') {
    process.stdout.write(`${JSON.stringify({ rows, gapCount: gaps.length }, null, 2)}\n`)
  }
  else {
    if (rows.length === 0) {
      process.stdout.write('No D1 ranges to audit.\n')
    }
    else {
      process.stdout.write('userId\tsiteId\ttable\tparquet range\td1 range\tstatus\tgap\n')
      for (const r of rows) {
        const parquet = r.parquetOldest && r.parquetNewest ? `${r.parquetOldest}..${r.parquetNewest}` : '<none>'
        const d1Range = `${r.d1Oldest}..${r.d1Newest}`
        const gap = [r.missingBefore ? `<${r.missingBefore}` : '', r.missingAfter ? `>${r.missingAfter}` : '']
          .filter(Boolean)
          .join(' ')
        process.stdout.write(`${r.userId}\t${r.siteId}\t${r.table}\t${parquet}\t${d1Range}\t${r.status}\t${gap}\n`)
      }
    }
    process.stdout.write(`\n${gaps.length} of ${rows.length} site-tables have gaps.\n`)
  }

  if (gaps.length > 0)
    process.exitCode = 1
}

run().catch((err: unknown) => {
  process.stderr.write(`backfill-audit failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
})
