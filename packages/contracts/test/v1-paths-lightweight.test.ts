import { describe, expect, it, vi } from 'vitest'

vi.mock('zod', () => {
  throw new Error('The lightweight paths subpath loaded Zod.')
})

describe('@gscdump/contracts/v1/paths dependency graph', () => {
  it('loads and builds paths without the schema runtime', async () => {
    const { createGscdumpV1Paths } = await import('@gscdump/contracts/v1/paths')

    expect(createGscdumpV1Paths().path('realtime.tickets.create'))
      .toBe('/api/realtime/v1/tickets')
  })
})
