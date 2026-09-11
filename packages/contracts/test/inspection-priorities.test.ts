import type { InspectionRecordRaw } from '@gscdump/contracts'
import { inspectionIndexSchema } from '@gscdump/contracts'
import { describe, expect, it } from 'vitest'

describe('inspection history priorities', () => {
  it.each(['high', 'medium', 'low', 'critical', 'elevated', 'normal', 'dormant'] as const)('preserves stored priority %s', (priority) => {
    const raw: InspectionRecordRaw = { priority }
    const input = {
      version: 1,
      records: { page: { url: 'https://example.com/page', inspectedAt: '2026-09-01T00:00:00Z', raw } },
    }

    const parsed = inspectionIndexSchema.parse(input)

    expect(parsed.records.page!.raw!.priority).toBe(priority)
  })

  it('rejects an unknown priority', () => {
    const input = {
      version: 1,
      records: { page: { url: 'https://example.com/page', inspectedAt: '2026-09-01T00:00:00Z', raw: { priority: 'urgent' } } },
    }
    expect(inspectionIndexSchema.safeParse(input).success).toBe(false)
  })
})
