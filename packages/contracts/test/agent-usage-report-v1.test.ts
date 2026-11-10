import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

describe('agent usage and report operations', () => {
  const protocol = createGscdumpV1Protocol()

  it('preserves unknown integration measurement rather than inventing zero activity', () => {
    const response = protocol.surfaces.partner.operations.getUserIntegrationActivity.responses[200].producer.parse({
      data: { measuredAt: '2026-11-10T00:00:00.000Z', activities: [{ surface: 'mcp', client: 'unknown', label: 'MCP', configuredUsers: null, successfulUsers: null, successfulCalls: null, firstObservedAt: null, lastObservedAt: null, coverage: 'unavailable', note: 'No retained credential observations.' }] },
      meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
    })
    expect(response.data.activities[0]).toMatchObject({ successfulCalls: null, coverage: 'unavailable' })
  })

  it.each([{ reportId: 'health', start: '2026-11-01' }, { reportId: 'health', start: '2026-11-10', end: '2026-11-01' }, { reportId: 'triage' }, { reportId: 'pre-publish' }])('rejects an incomplete report request: %j', (body) => {
    expect(protocol.surfaces.analytics.operations.runReport.request.body.safeParse(body).success).toBe(false)
  })

  it('preserves degraded and truncated evidence without severity or advice', () => {
    const response = protocol.surfaces.analytics.operations.runReport.responses[200].producer.parse({
      data: { site: 'https://example.com/', generatedAt: '2026-11-10T00:00:00.000Z', cached: true, window: { start: '2026-10-01', end: '2026-10-28', days: 28 }, meta: { durationMs: 5, rowsScanned: 25, degraded: true, steps: [{ key: 'movers', type: 'movers', status: 'done', coverage: { kind: 'truncated', fetched: 25 } }] }, sections: [{ id: 'movers', title: 'Movers', summary: {}, coverage: 'partial', truncated: { kept: 5, total: 25 }, dataUnavailable: true, findings: [] }] },
      meta: { requestId: 'req_01', surface: 'analytics', version: '1.0' },
    })
    expect(response.data.meta.steps[0]?.coverage).toEqual({ kind: 'truncated', fetched: 25 })
    expect(response.data.sections[0]).toMatchObject({ dataUnavailable: true, truncated: { kept: 5, total: 25 } })
  })
})
