import { describe, expect, it } from 'vitest'
import {
  gscdumpSitemapChangesResponseSchema,
  sitemapChangesResponseSchema,
} from '../src'
import { createGscdumpV1Protocol } from '../src/v1'

const baseChanges = {
  added: [],
  removed: [],
  updated: [],
  generation: null,
  summary: {
    totalAdded: 0,
    totalRemoved: 0,
    totalUpdated: 0,
    period: { days: 28 },
  },
}

const completeChanges = {
  ...baseChanges,
  completeness: {
    _tag: 'complete',
    scannedUrls: 0,
  },
} as const

const truncatedChanges = {
  ...baseChanges,
  completeness: {
    _tag: 'truncated',
    scannedUrls: 250_000,
    reasons: ['scan_limit'],
    limits: {
      scannedUrls: 250_000,
      added: 200,
      removed: 200,
      updated: 200,
    },
  },
} as const

describe('sitemap changes completeness', () => {
  it('requires one tagged completeness state on hosted response schemas', () => {
    for (const schema of [sitemapChangesResponseSchema, gscdumpSitemapChangesResponseSchema]) {
      expect(schema.parse(completeChanges)).toMatchObject(completeChanges)
      expect(schema.parse(truncatedChanges)).toMatchObject(truncatedChanges)
      expect(schema.safeParse(baseChanges).success).toBe(false)
      expect(schema.safeParse({
        ...truncatedChanges,
        completeness: {
          ...truncatedChanges.completeness,
          reasons: [],
        },
      }).success).toBe(false)
    }
  })

  it('keeps the public v1 producer strict and its client additive', () => {
    const protocol = createGscdumpV1Protocol()
    const response = protocol.surfaces.partner.operations.getSiteSitemapChanges.responses[200]!
    const envelope = {
      data: completeChanges,
      meta: {
        requestId: 'req_01',
        surface: 'partner',
        version: '1.0',
      },
    }

    expect(response.producer.parse(envelope)).toEqual(envelope)
    expect(response.producer.safeParse({
      ...envelope,
      data: {
        ...envelope.data,
        completeness: {
          ...envelope.data.completeness,
          futureField: true,
        },
      },
    }).success).toBe(false)
    expect(response.client.parse({
      ...envelope,
      data: {
        ...envelope.data,
        completeness: {
          ...envelope.data.completeness,
          futureField: true,
        },
      },
    })).toMatchObject({
      data: {
        completeness: {
          _tag: 'complete',
          futureField: true,
        },
      },
    })
  })

  it('marks windows before the canonical history floor as unavailable', () => {
    expect(gscdumpSitemapChangesResponseSchema.parse({
      ...baseChanges,
      completeness: {
        _tag: 'truncated',
        scannedUrls: 0,
        reasons: ['history_unavailable'],
        historyAvailableFrom: 1_753_746_000_000,
        limits: {
          scannedUrls: 250_000,
          added: 200,
          removed: 200,
          updated: 200,
        },
      },
    })).toMatchObject({
      completeness: {
        reasons: ['history_unavailable'],
        historyAvailableFrom: 1_753_746_000_000,
      },
    })
  })
})
