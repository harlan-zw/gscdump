// One-off: per-site Iceberg delete against the PROD R2 Data Catalog, run from
// the engine repo's LOCAL source (the deleteSiteFromShard op is unpublished).
// Reads prod R2 creds from gscdump.com/.env. Runs PyIceberg locally via the
// gscdump POC venv.
//
//   GSCDUMP_DOTENV=/home/harlan/sites/gscdump.com/.env \
//   pnpm tsx packages/engine/scripts/delete-site-prod.mts --team <id> --int-id <N> [--apply]

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { deleteSiteFromShard, subprocessBackend } from '../src/iceberg/overwrite-writer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOTENV = process.env.GSCDUMP_DOTENV ?? '/home/harlan/sites/gscdump.com/.env'
const WRITER = join(HERE, 'iceberg-writer.py')
const VENV_PY = process.env.GSCDUMP_ICEBERG_PYTHON ?? '/home/harlan/sites/gscdump.com/poc/iceberg/.venv/bin/python'
const FACT_TABLES = ['pages', 'queries', 'countries', 'page_queries', 'dates']

const dotenvText = readFileSync(DOTENV, 'utf8')
function env(key: string): string {
  const m = dotenvText.match(new RegExp(`^${key}=(.+)$`, 'm'))
  const v = (process.env[key] ?? m?.[1] ?? '').replace(/^['"]|['"]$/g, '').trim()
  if (!v)
    throw new Error(`Missing ${key}`)
  return v
}

const argv = process.argv.slice(2)
function arg(f: string) {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const team = arg('--team')
const intId = Number.parseInt(arg('--int-id') ?? '', 10)
const apply = argv.includes('--apply')
if (!team || !Number.isSafeInteger(intId))
  throw new Error('usage: --team <id> --int-id <N> [--apply]')
if (!existsSync(VENV_PY))
  throw new Error(`venv python not found: ${VENV_PY}`)

const accountId = env('CLOUDFLARE_ACCOUNT_ID')
const bucket = `gsc-team-${team}-int`
const catalog = {
  catalogUri: `https://catalog.cloudflarestorage.com/${accountId}/${bucket}`,
  warehouse: `${accountId}_${bucket}`,
  namespace: 'gsc',
  catalogToken: env('R2_CATALOG_TOKEN'),
  s3: {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    region: 'auto',
  },
}

console.log(`Per-site Iceberg delete${apply ? '' : ' (DRY-RUN)'}: site_id=${intId} in ${catalog.warehouse}`)
if (!apply) {
  console.log('Re-run with --apply to execute.')
  process.exit(0)
}

const results = await deleteSiteFromShard({
  catalog,
  backend: subprocessBackend({ python: VENV_PY, writerScript: WRITER }),
  siteId: intId,
  tables: FACT_TABLES,
})
let bad = false
for (const r of results) {
  if (r.error) {
    bad = true
    console.log(`  ✗ ${r.table.padEnd(14)} ${r.error}`)
  }
  else {
    console.log(`  ✓ ${r.table.padEnd(14)} deleted ${r.rowCount ?? '?'} rows`)
  }
}
process.exit(bad ? 1 : 0)
