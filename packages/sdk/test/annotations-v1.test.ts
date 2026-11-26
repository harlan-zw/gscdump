import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const meta = { requestId: 'req_ann', surface: 'partner', version: '1.0' } as const

describe('annotations v1 SDK client', () => {
  it('lists chart annotations with optional date bounds and preserves additive fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const requested = new URL(String(url), 'https://example.com')
      expect(requested.pathname).toBe('/api/_gscdump/partner/v1/sites/s_site/chart-annotations')
      expect(Object.fromEntries(requested.searchParams)).toEqual({ startDate: '2026-10-01', endDate: '2026-10-31' })
      expect(init?.method).toBe('GET')
      return Response.json({
        data: {
          annotations: [
            { id: 'ann_01', date: '2026-10-12', label: 'Migration', category: 'custom', tone: 'neutral', editable: true, futureField: 1 },
            { id: 'algo:core-2026-10', date: '2026-10-15', label: 'October Core Update', category: 'algo-update', tone: 'warning', editable: false },
          ],
        },
        meta,
      })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'user_secret', fetch })
    const result = await client.getChartAnnotations({
      params: { siteId: 's_site' },
      query: { startDate: '2026-10-01', endDate: '2026-10-31' },
    })
    expect(result.data.annotations).toHaveLength(2)
    expect(result.data.annotations[0]).toMatchObject({ id: 'ann_01', category: 'custom', futureField: 1 })
  })

  it('lists, creates, updates, and deletes custom site annotations', async () => {
    const calls: { method: string, pathname: string, body: unknown }[] = []
    const annotation = {
      id: 'ann_01',
      siteId: 's_site',
      date: '2026-10-12',
      title: 'Migration',
      note: 'Moved docs',
      url: 'https://example.com/changelog',
      createdAt: 1791763200,
      updatedAt: 1791763200,
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const requested = new URL(String(url), 'https://example.com')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method: init?.method ?? 'GET', pathname: requested.pathname, body })
      if (init?.method === 'GET')
        return Response.json({ data: { annotations: [annotation] }, meta })
      if (init?.method === 'POST')
        return Response.json({ data: { annotation }, meta })
      if (init?.method === 'PATCH')
        return Response.json({ data: { annotation: { ...annotation, title: body.title } }, meta })
      if (init?.method === 'DELETE')
        return Response.json({ data: { deleted: true, id: 'ann_01' }, meta })
      throw new Error(`Unexpected method ${init?.method}`)
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'user_secret', fetch })

    const listed = await client.listSiteAnnotations({ params: { siteId: 's_site' } })
    expect(listed.data.annotations).toEqual([annotation])

    const created = await client.createSiteAnnotation({
      params: { siteId: 's_site' },
      body: { date: '2026-10-12', title: 'Migration', note: 'Moved docs', url: 'https://example.com/changelog' },
    })
    expect(created.data.annotation.id).toBe('ann_01')

    const updated = await client.updateSiteAnnotation({
      params: { siteId: 's_site', annotationId: 'ann_01' },
      body: { title: 'Migration complete' },
    })
    expect(updated.data.annotation.title).toBe('Migration complete')

    const deleted = await client.deleteSiteAnnotation({
      params: { siteId: 's_site', annotationId: 'ann_01' },
    })
    expect(deleted.data).toEqual({ deleted: true, id: 'ann_01' })

    expect(calls.map(call => `${call.method} ${call.pathname}`)).toEqual([
      'GET /api/_gscdump/partner/v1/sites/s_site/annotations',
      'POST /api/_gscdump/partner/v1/sites/s_site/annotations',
      'PATCH /api/_gscdump/partner/v1/sites/s_site/annotations/ann_01',
      'DELETE /api/_gscdump/partner/v1/sites/s_site/annotations/ann_01',
    ])
  })
})
