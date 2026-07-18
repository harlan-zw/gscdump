/**
 * Full end-to-end against REAL DuckDB-WASM + REAL OPFS in chromium.
 *
 * Everything else stubs the `db` (it opens sync access handles in a worker to
 * model exclusivity). This suite boots an actual DuckDB-WASM instance, attaches
 * a real parquet file via `attachOpfsParquetTables` (which registers the OPFS
 * handle with DuckDB's `BROWSER_FSACCESS`), and runs real SQL — so the registry
 * + view-refcount lifecycle is exercised against the genuine engine and the
 * genuine one-sync-access-handle-per-file rule.
 *
 * Hermetic: the WASM module + worker are served from node_modules via Vite
 * `?url` imports (no jsDelivr, no cross-origin-isolation needed — the MVP bundle
 * is single-threaded so SharedArrayBuffer/COEP don't come into play).
 *
 * Run with `pnpm --filter @gscdump/engine-duckdb-wasm test:browser`.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
// @ts-expect-error - Vite ?url asset import, no type decl
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
// @ts-expect-error - Vite ?url asset import, no type decl
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import { encodeRowsToParquetFlex } from '@gscdump/engine/hyparquet'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { attachOpfsParquetTables, clearOpfsSnapshotCache } from '../src/opfs'
import { bootDuckDBWasm } from '../src/runtime'

// `?url` yields a root-relative `/@fs/...` path; `importScripts` inside the
// blob worker (opaque origin) can't resolve a relative URL, so make it absolute
// against the dev server origin.
const absWasm = new URL(mvpWasm as string, location.href).href
const absWorker = new URL(mvpWorker as string, location.href).href
const bundles = {
  mvp: { mainModule: absWasm, mainWorker: absWorker },
  eh: { mainModule: absWasm, mainWorker: absWorker },
}

function datesParquet(rows: Array<{ date: string, clicks: number }>): Uint8Array {
  return encodeRowsToParquetFlex(rows, {
    columns: [
      { name: 'date', type: 'DATE', nullable: false },
      { name: 'clicks', type: 'INTEGER', nullable: false },
    ],
  })
}

function bytesFetch(payload: Uint8Array): typeof fetch {
  return (async () => new Response(payload.slice().buffer, { status: 200 })) as unknown as typeof fetch
}

// Routes by URL substring so lake and overlay can serve DIFFERENT payloads from
// one fetch (bytesFetch returns the same bytes for every request).
function routeFetch(routes: Array<{ match: string, payload: Uint8Array }>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const route = routes.find(r => url.includes(r.match))
    if (!route)
      return new Response(null, { status: 404 })
    return new Response(route.payload.slice().buffer, { status: 200 })
  }) as unknown as typeof fetch
}

async function rows(conn: AsyncDuckDBConnection, sql: string): Promise<any[]> {
  const res = await conn.query(sql)
  return (res as any).toArray().map((r: any) => (typeof r.toJSON === 'function' ? r.toJSON() : r))
}

describe('real DuckDB-WASM + real OPFS e2e', () => {
  let db: AsyncDuckDB
  let conn: AsyncDuckDBConnection

  beforeAll(async () => {
    const booted = await bootDuckDBWasm({ bundles })
    db = booted.db
    conn = booted.conn
  }, 60_000)

  afterEach(async () => {
    await clearOpfsSnapshotCache()
  })

  it('attaches a real parquet into OPFS and queries it through BROWSER_FSACCESS', async () => {
    const parquet = datesParquet([{ date: '2026-05-01', clicks: 10 }, { date: '2026-05-02', clicks: 20 }])
    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: bytesFetch(parquet),
      tables: [{ table: 'dates', files: [{ url: '/p', bytes: parquet.byteLength, contentHash: 'e2e/single.parquet' }] }],
    })
    expect(handle.tables).toEqual(['dates'])
    expect(handle.degradedTables).toEqual([])

    const out = await rows(conn, 'SELECT clicks FROM main.dates ORDER BY date')
    expect(out.map(r => Number(r.clicks))).toEqual([10, 20])

    await handle.detach()
    // After detach the view is gone — querying it must now fail.
    await expect(conn.query('SELECT * FROM main.dates')).rejects.toThrow()
  }, 60_000)

  it('break attempt: shared-DB churn — detaching consumer A must not break consumer B live query', async () => {
    // The exact production hazard, end to end with REAL DuckDB: two consumers
    // share one DB and attach the SAME parquet (same view, same OPFS file). If
    // the view/handle refcount is wrong, A's detach drops the view or releases
    // the sync access handle out from under B, and B's NEXT real query throws
    // "Table main.dates does not exist" / a read error.
    const parquet = datesParquet([{ date: '2026-05-10', clicks: 7 }, { date: '2026-05-11', clicks: 8 }])
    const file = { url: '/shared', bytes: parquet.byteLength, contentHash: 'e2e/shared.parquet' }
    const mk = () => attachOpfsParquetTables({ db, conn, fetch: bytesFetch(parquet), tables: [{ table: 'dates', files: [file] }] })

    const [a, b] = await Promise.all([mk(), mk()])
    expect(a.tables).toEqual(['dates'])
    expect(b.tables).toEqual(['dates'])

    // Both consumers can query.
    expect((await rows(conn, 'SELECT count(*) AS n FROM main.dates'))[0].n).toBeTruthy()

    // Consumer A navigates away.
    await a.detach()

    // Consumer B must STILL be able to query the real view through the real
    // (still-registered) OPFS handle. This is the assertion that breaks if the
    // refcount fix is wrong.
    const out = await rows(conn, 'SELECT clicks FROM main.dates ORDER BY date')
    expect(out.map(r => Number(r.clicks))).toEqual([7, 8])

    // Last consumer detaches: view + handle gone.
    await b.detach()
    await expect(conn.query('SELECT * FROM main.dates')).rejects.toThrow()
  }, 60_000)

  it('overlay view: lake serves its days, overlay fills only the gap (streaming anti-join)', async () => {
    // Lake covers days 1-3; the recent-window overlay covers days 3-5 with a
    // STALE day-3 (clicks 999) the lake already has. Against the REAL engine the
    // anti-join must: let the lake win day 3 (clicks 30, not 999), serve the
    // overlay ONLY for days 4-5, and never double-count day 3. This is the
    // end-to-end proof that the streaming, pushdown-friendly rewrite preserves
    // the same dedup semantics.
    const lake = datesParquet([
      { date: '2026-05-01', clicks: 10 },
      { date: '2026-05-02', clicks: 20 },
      { date: '2026-05-03', clicks: 30 },
    ])
    const overlay = datesParquet([
      { date: '2026-05-03', clicks: 999 },
      { date: '2026-05-04', clicks: 40 },
      { date: '2026-05-05', clicks: 50 },
    ])
    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: routeFetch([{ match: '/lake', payload: lake }, { match: '/overlay', payload: overlay }]),
      tables: [{
        table: 'dates',
        files: [{ url: '/lake', bytes: lake.byteLength, contentHash: 'e2e/overlay-lake.parquet' }],
        overlay: { url: '/overlay', bytes: overlay.byteLength, contentHash: 'e2e/overlay-tail.parquet' },
      }],
    })
    expect(handle.tables).toEqual(['dates'])
    expect(handle.degradedTables).toEqual([])

    // Ordered by date: exactly 5 rows (no duplicate day 3), day 3 = lake's 30.
    const out = await rows(conn, 'SELECT clicks FROM main.dates ORDER BY date')
    expect(out.map(r => Number(r.clicks))).toEqual([10, 20, 30, 40, 50])
    // The stale overlay row for day 3 is gone.
    expect(out.map(r => Number(r.clicks))).not.toContain(999)

    await handle.detach()
  }, 60_000)

  it('break attempt: re-attach the same file after a full detach (stale-handle leak)', async () => {
    // If detach leaked the sync access handle, re-registering the same OPFS file
    // would hit the real exclusivity error and the table would degrade.
    const parquet = datesParquet([{ date: '2026-05-20', clicks: 42 }])
    const file = { url: '/re', bytes: parquet.byteLength, contentHash: 'e2e/reattach.parquet' }
    const mk = () => attachOpfsParquetTables({ db, conn, fetch: bytesFetch(parquet), tables: [{ table: 'dates', files: [file] }] })

    const first = await mk()
    await first.detach()

    const second = await mk()
    expect(second.tables).toEqual(['dates'])
    expect(second.degradedTables).toEqual([])
    const out = await rows(conn, 'SELECT clicks FROM main.dates')
    expect(out.map(r => Number(r.clicks))).toEqual([42])
    await second.detach()
  }, 60_000)
})
