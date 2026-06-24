import { describe, expect, it } from 'vitest'
import { overlayViewBody } from '../src/overlay-view'

// The browser-side merge-on-read primitive shared by the OPFS attach path and
// consumers' in-memory `registerParquetView`. The four short-circuits + the two
// merge shapes (MATERIALIZED vs streaming re-scan) are the whole contract.
const LAKE = 'SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet([\'/lake\'])'
const OVERLAY = 'SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet([\'/overlay\'])'

describe('overlayViewBody', () => {
  it('neither side → null', () => {
    expect(overlayViewBody({ lakeSelect: null, overlaySelect: null })).toBeNull()
  })

  it('lake only → the lake select verbatim (no dedup, no wrapping)', () => {
    expect(overlayViewBody({ lakeSelect: LAKE, overlaySelect: null })).toBe(LAKE)
  })

  it('overlay only → the overlay select verbatim (every recent row is wanted)', () => {
    // No lake to anti-join against, so the overlay is returned unwrapped.
    expect(overlayViewBody({ lakeSelect: null, overlaySelect: OVERLAY })).toBe(OVERLAY)
  })

  it('merge (default) → MATERIALIZED lake reused for rows + anti-join date set', () => {
    const sql = overlayViewBody({ lakeSelect: LAKE, overlaySelect: OVERLAY })!
    // The lake is scanned ONCE: read_parquet appears once for the lake (inside the
    // CTE) + once for the overlay = 2 total, never a third for the anti-join.
    expect((sql.match(/read_parquet\(/g) ?? []).length).toBe(2)
    expect(sql).toMatch(/WITH lake AS MATERIALIZED/i)
    expect(sql).toMatch(/UNION ALL BY NAME/i)
    expect(sql).toMatch(/NOT IN \(SELECT date FROM lake_dates\)/i)
  })

  it('merge with materializeLake:false → streaming re-scan (two lake scans, lower peak memory)', () => {
    const sql = overlayViewBody({ lakeSelect: LAKE, overlaySelect: OVERLAY, materializeLake: false })!
    expect(sql).not.toMatch(/MATERIALIZED/i)
    // Lake re-scanned: once for served rows, once inside the anti-join subquery.
    expect((sql.match(/read_parquet\(/g) ?? []).length).toBe(3)
    expect(sql).toMatch(/UNION ALL BY NAME/i)
    expect(sql).toMatch(/NOT IN \(SELECT DISTINCT date FROM/i)
  })

  it('overlay branch is subquery-wrapped so an inner GROUP BY / JOIN composes', () => {
    // The server sibling relies on this to feed a canonical-grain (GROUP BY)
    // overlay select; assert the wrap so the browser primitive stays compatible.
    const grouped = `${OVERLAY} GROUP BY query_canonical, date`
    const sql = overlayViewBody({ lakeSelect: LAKE, overlaySelect: grouped, materializeLake: false })!
    expect(sql).toContain(`(${grouped}) AS overlay`)
  })
})
