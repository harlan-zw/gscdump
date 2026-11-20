import { createGscdumpV1Protocol } from '@gscdump/contracts/v1/http'
import { expect, it } from 'vitest'

const operations = createGscdumpV1Protocol().surfaces.analytics.operations
const legacyHistory = { _tag: 'LegacyHistory', historicalHostScope: 'unverified', dates: ['2026-11-18'] }
const disclosure = { legacyHistory, warnings: ['Legacy history: Historical host scope is unverified for these dates.'] }
const envelope = { requestId: `req_${'a'.repeat(32)}`, surface: 'analytics', version: '1.0' }
const rows = { data: { rows: [{ clicks: 12 }] }, meta: { ...envelope, sourceName: 'iceberg-r2sql', sourceKind: 'sql', queryMs: 1, ...disclosure } }
const report = {
  data: {
    site: 's_fixture',
    generatedAt: '2026-11-20T00:00:00.000Z',
    cached: false,
    window: { start: '2026-11-18', end: '2026-11-18', days: 1 },
    meta: { durationMs: 1, rowsScanned: 1, degraded: false, steps: [], ...disclosure },
    sections: [],
  },
  meta: envelope,
}

it.each(['producer', 'client'] as const)('preserves imported provenance in populated and empty rows for the %s', (boundary) => {
  const schema = operations.queryRows.responses[200][boundary]
  expect(schema.parse(rows)).toMatchObject({ meta: disclosure })
  expect(schema.parse({ ...rows, data: { rows: [] } })).toMatchObject({ data: { rows: [] }, meta: disclosure })
})

it.each(['producer', 'client'] as const)('preserves imported provenance in Reports for the %s', (boundary) => {
  const schema = operations.runReport.responses[200][boundary]
  expect(schema.parse(report)).toMatchObject({ data: { meta: disclosure } })
  const provider = { ...report, data: { ...report.data, meta: { durationMs: 1, rowsScanned: 0, degraded: false, steps: [] } } }
  expect(schema.parse(provider)).toEqual(provider)
  for (const invalid of [
    { ...legacyHistory, historicalHostScope: 'verified' },
    { ...legacyHistory, dates: [] },
    { ...legacyHistory, dates: ['2026-02-30'] },
  ]) {
    expect(schema.safeParse({ ...report, data: { ...report.data, meta: { ...report.data.meta, legacyHistory: invalid } } }).success).toBe(false)
  }
})
