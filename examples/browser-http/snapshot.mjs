#!/usr/bin/env node
// Hot/cold snapshot builder.
//
// Layout produced under examples/browser-http/_snapshots/:
//   cold-YYYY-MM.duckdb   one per closed month (immutable — CDN can cache
//                         forever). Built once when the month closes, then
//                         never rewritten.
//   hot.duckdb            last 30 days of calendar data. Rewritten every
//                         time this script runs; small (kB–low MB).
//   index.json            { cold: ['2024-09', ...], hot: true }
//                         list of available months + whether hot exists.
//
// Cost model:
//   - On a day with no month rollover: only hot.duckdb is rewritten.
//     Read cost = the last 30 per-day Parquets. Write cost = one small
//     .duckdb file.
//   - On month rollover: plus one new cold-<prev-month>.duckdb built from
//     ~30 daily Parquets. O(monthly), not O(total history).
//   - Cold files are never rewritten. Perfect for HTTP cache / CDN.
//
// Run (proxy.mjs must be serving on :8081):
//   node examples/browser-http/snapshot.mjs          # incremental
//   node examples/browser-http/snapshot.mjs --force  # rebuild everything

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(DIR, '_snapshots')
const HOT_DAYS = 30

async function loadEnv(p) {
  try {
    const raw = await readFile(p, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^(\w+)=(.*)$/.exec(line.trim())
      if (!m || (m[1] in process.env))
        continue
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  catch {}
}
await loadEnv(path.join(DIR, '..', '..', '.env'))

const FORCE = process.argv.includes('--force')
const PROXY = process.env.PROXY_URL ?? 'http://127.0.0.1:8081'
const USER = process.env.GSCDUMP_USER_ID

function sqlEscape(s) { return s.replace(/'/g, '\'\'') }

function dayOf(partition) {
  // 'daily/2026-04-10' → '2026-04-10'
  return partition.replace(/^daily\//, '')
}

function monthOf(partition) {
  return dayOf(partition).slice(0, 7) // 'YYYY-MM'
}

function daysAgo(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`).getTime()
  return Math.floor((Date.now() - d) / 86400000)
}

async function fetchManifest() {
  const res = await fetch(`${PROXY}/manifest.json`)
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`)
  return res.json()
}

async function buildMonthlyFile(outPath, month, entriesByTable) {
  await rm(outPath, { force: true })
  const inst = await DuckDBInstance.create(outPath)
  const conn = await inst.connect()
  await conn.run(`INSTALL httpfs; LOAD httpfs`)
  try {
    for (const [table, entries] of entriesByTable) {
      if (entries.length === 0) continue
      const urls = entries.map(e => `'${sqlEscape(`${PROXY}/${e.objectKey}`)}'`)
      await conn.run(
        `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_parquet([${urls.join(', ')}], union_by_name = true)`,
      )
    }
  }
  finally {
    conn.closeSync()
    inst.closeSync()
  }
  return (await stat(outPath)).size
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  const manifest = await fetchManifest()
  const entries = manifest.entries.filter(e => e.userId === USER)
  if (entries.length === 0) {
    console.log('no entries for user')
    return
  }

  // Classify each manifest entry by (table, yearMonth) + whether it's hot (≤HOT_DAYS old).
  const today = todayUTC()
  const hotThreshold = Date.now() - HOT_DAYS * 86400000
  const byMonthTable = new Map() // Map<yearMonth, Map<table, entries[]>>
  const hotByTable = new Map()   // Map<table, entries[]>

  for (const e of entries) {
    const day = dayOf(e.partition)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const dayMs = new Date(`${day}T00:00:00Z`).getTime()
    const ym = day.slice(0, 7)
    if (dayMs >= hotThreshold) {
      if (!hotByTable.has(e.table)) hotByTable.set(e.table, [])
      hotByTable.get(e.table).push(e)
    }
    else {
      if (!byMonthTable.has(ym)) byMonthTable.set(ym, new Map())
      const m = byMonthTable.get(ym)
      if (!m.has(e.table)) m.set(e.table, [])
      m.get(e.table).push(e)
    }
  }

  // Build cold-YYYY-MM.duckdb for any month not yet on disk (or --force).
  // A month is "closed" once it's wholly older than HOT_DAYS, so only those
  // show up in byMonthTable. Cold files are written once, never rewritten.
  const existing = new Set(
    (await readdir(OUT_DIR).catch(() => []))
      .filter(f => /^cold-\d{4}-\d{2}\.duckdb$/.test(f))
      .map(f => f.replace(/^cold-|\.duckdb$/g, '')),
  )

  const coldMonths = [...byMonthTable.keys()].sort()
  const t0 = Date.now()
  let builtCold = 0
  let skippedCold = 0
  for (const ym of coldMonths) {
    const outPath = path.join(OUT_DIR, `cold-${ym}.duckdb`)
    if (existing.has(ym) && !FORCE) {
      skippedCold++
      continue
    }
    const tm = Date.now()
    const bytes = await buildMonthlyFile(outPath, ym, byMonthTable.get(ym))
    console.log(`  cold-${ym}.duckdb  ${(bytes / 1024).toFixed(1)} KB  ${Date.now() - tm} ms`)
    builtCold++
  }

  // Always rebuild hot.duckdb.
  const hotPath = path.join(OUT_DIR, 'hot.duckdb')
  const tHot = Date.now()
  const hotBytes = await buildMonthlyFile(hotPath, 'hot', hotByTable)
  console.log(`  hot.duckdb         ${(hotBytes / 1024).toFixed(1)} KB  ${Date.now() - tHot} ms  (${[...hotByTable.values()].reduce((a, v) => a + v.length, 0)} parquets, last ${HOT_DAYS} days)`)

  // Write index.json
  const index = {
    version: 1,
    builtAt: today,
    cold: coldMonths,
    hot: true,
    hotDays: HOT_DAYS,
  }
  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2))

  console.log(`\n  total: built ${builtCold} cold, skipped ${skippedCold} cold, rebuilt hot · ${Date.now() - t0} ms`)
  console.log(`  index: ${coldMonths.length} cold months + hot`)
}

await main()
