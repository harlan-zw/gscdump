import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const meta = {
  requestId: 'req_bing',
  surface: 'partner' as const,
  version: '1.0' as const,
}

describe('bing indexing evidence v1', () => {
  it('parses observed, unknown, and unavailable evidence without an indexed verdict', () => {
    const protocol = createGscdumpV1Protocol()
    const operation = protocol.surfaces.partner.operations.listSiteBingIndexingEvidence
    const response = operation.responses[200].producer.parse({
      data: {
        searchEngine: 'bing',
        siteUrl: 'https://nuxtseo.com/',
        indexingEvidence: [
          {
            _tag: 'observed',
            searchEngine: 'bing',
            url: 'https://nuxtseo.com/',
            observedAt: '2026-08-11T13:35:27.000Z',
            providerEvidenceAt: '2026-08-11T09:20:51.000Z',
            freshness: 'current',
            discoveryTime: '2023-07-07T07:00:00.000Z',
            lastCrawlTime: '2026-08-11T09:20:51.000Z',
            originHttpStatus: null,
            documentSize: 367800,
            anchorCount: 298,
            totalChildUrlCount: 0,
            uncertaintyReason: 'indexed-verdict-unavailable',
          },
          {
            _tag: 'unknown',
            searchEngine: 'bing',
            url: 'https://nuxtseo.com/new',
            observedAt: '2026-08-11T13:35:27.000Z',
            reason: 'not-discovered',
          },
          {
            _tag: 'observed',
            searchEngine: 'bing',
            url: 'https://nuxtseo.com/stale',
            observedAt: '2026-08-11T13:35:27.000Z',
            providerEvidenceAt: '2026-07-01T09:20:51.000Z',
            freshness: 'stale',
            discoveryTime: null,
            lastCrawlTime: '2026-07-01T09:20:51.000Z',
            originHttpStatus: null,
            documentSize: 2048,
            anchorCount: 2,
            totalChildUrlCount: 0,
            uncertaintyReason: 'indexed-verdict-unavailable',
          },
          {
            _tag: 'unavailable',
            searchEngine: 'bing',
            url: 'https://nuxtseo.com/private',
            observedAt: '2026-08-11T13:35:27.000Z',
            reason: 'authentication-required',
            retryAt: null,
          },
        ],
        pagination: { total: 4, limit: 100, offset: 0, hasMore: false },
      },
      meta,
    })

    expect(response.data.indexingEvidence.map(item => item._tag)).toEqual([
      'observed',
      'unknown',
      'observed',
      'unavailable',
    ])
    expect(response.data.indexingEvidence[2]).toMatchObject({ freshness: 'stale' })
    expect(response.data.indexingEvidence[0]).not.toHaveProperty('verdict')
  })

  it('rejects observed evidence with no provider evidence time', () => {
    const protocol = createGscdumpV1Protocol()
    const response = protocol.surfaces.partner.operations.listSiteBingIndexingEvidence.responses[200]

    expect(() => response.producer.parse({
      data: {
        searchEngine: 'bing',
        siteUrl: 'https://nuxtseo.com/',
        indexingEvidence: [{
          _tag: 'observed',
          searchEngine: 'bing',
          url: 'https://nuxtseo.com/',
          observedAt: '2026-08-11T13:35:27.000Z',
          providerEvidenceAt: null,
          freshness: 'current',
          discoveryTime: null,
          lastCrawlTime: null,
          originHttpStatus: null,
          documentSize: 0,
          anchorCount: 0,
          totalChildUrlCount: 0,
          uncertaintyReason: 'indexed-verdict-unavailable',
        }],
        pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
      },
      meta,
    })).toThrow()
  })
})
