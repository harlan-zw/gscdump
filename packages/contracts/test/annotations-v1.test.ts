import {
  chartAnnotationsQueryV1Schema,
  createGscdumpV1Protocol,
  createSiteAnnotationV1Schema,
  updateSiteAnnotationV1Schema,
} from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

describe('annotations v1 contracts', () => {
  it('registers all five chart and site annotation operations on the partner surface', () => {
    const { operations } = createGscdumpV1Protocol().surfaces.partner
    expect(operations.getChartAnnotations).toMatchObject({
      id: 'partner.sites.chart_annotations.list',
      method: 'GET',
      path: '/sites/{siteId}/chart-annotations',
    })
    expect(operations.listSiteAnnotations).toMatchObject({
      id: 'partner.sites.annotations.list',
      method: 'GET',
      path: '/sites/{siteId}/annotations',
    })
    expect(operations.createSiteAnnotation).toMatchObject({
      id: 'partner.sites.annotations.create',
      method: 'POST',
      path: '/sites/{siteId}/annotations',
    })
    expect(operations.updateSiteAnnotation).toMatchObject({
      id: 'partner.sites.annotations.update',
      method: 'PATCH',
      path: '/sites/{siteId}/annotations/{annotationId}',
    })
    expect(operations.deleteSiteAnnotation).toMatchObject({
      id: 'partner.sites.annotations.delete',
      method: 'DELETE',
      path: '/sites/{siteId}/annotations/{annotationId}',
    })
  })

  it('validates chart annotation date windows and rejects reversed ranges', () => {
    expect(chartAnnotationsQueryV1Schema.parse({})).toEqual({})
    expect(chartAnnotationsQueryV1Schema.parse({ startDate: '2026-10-01', endDate: '2026-10-31' })).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    })
    expect(chartAnnotationsQueryV1Schema.safeParse({ startDate: '2026-10-31', endDate: '2026-10-01' }).success).toBe(false)
    expect(chartAnnotationsQueryV1Schema.safeParse({ startDate: 'not-a-date' }).success).toBe(false)
  })

  it('validates create and update annotation payloads strictly', () => {
    expect(createSiteAnnotationV1Schema.parse({
      date: '2026-10-12',
      title: '  Deploy v2  ',
      note: '  Shipped new nav  ',
      url: 'https://example.com/release',
    })).toEqual({
      date: '2026-10-12',
      title: 'Deploy v2',
      note: 'Shipped new nav',
      url: 'https://example.com/release',
    })
    expect(createSiteAnnotationV1Schema.safeParse({
      date: '2026-10-12',
      title: 'Bad link',
      url: 'javascript:alert(1)',
    }).success).toBe(false)
    expect(updateSiteAnnotationV1Schema.safeParse({}).success).toBe(false)
    expect(updateSiteAnnotationV1Schema.parse({ note: null, url: null })).toEqual({ note: null, url: null })
  })
})
