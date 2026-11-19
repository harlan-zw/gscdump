import { expect, it } from 'vitest'
import { siteVersionBeginRequestSchema, siteVersionCandidateSchema } from '../src/partner'

const history = { startDate: '2025-02-22', endDate: '2026-11-16' }
const candidate = {
  version: 1,
  namespace: 'gsc_v1',
  requestedUrl: 'https://example.test/',
  window: history,
  requiredSlices: [{ table: 'dates', searchType: 'web' }],
}

it.each(['collecting', 'verified', 'active', 'aborted', 'failed'] as const)('preserves a long history window in a %s candidate response', (state) => {
  const response = { ...candidate, state, ...(state === 'failed' ? { failure: 'provisioning-incomplete' } : {}) }
  expect(siteVersionCandidateSchema.parse(response)).toEqual(response)
})

it.each([
  { startDate: '2026-11-16', endDate: '2025-02-22' },
  { startDate: '2026-02-30', endDate: '2026-11-16' },
])('rejects an invalid candidate history window: %j', (window) => {
  expect(siteVersionCandidateSchema.safeParse({ ...candidate, window, state: 'collecting' }).success).toBe(false)
})

it.each([
  { endDate: '2026-10-26', accepted: true },
  { endDate: '2026-10-27', accepted: false },
])('bounds collection requests at 56 days: $endDate', ({ endDate, accepted }) => {
  const request = { preview: {
    _tag: 'eligible',
    identity: {
      siteId: 's_fixture',
      userId: 'u_fixture',
      teamId: 't_fixture',
      requestedUrl: candidate.requestedUrl,
      catalogSiteId: 17,
      warehouse: 'fixture_catalog',
      namespace: 'gsc',
      version: 0,
      revision: 1,
      catalogRevision: 1,
      dataVersion: 1,
    },
    requestedUrl: candidate.requestedUrl,
    window: { startDate: '2026-09-01', endDate },
    requiredSlices: candidate.requiredSlices,
    candidateNamespace: candidate.namespace,
    candidateVersion: candidate.version,
  } }
  const result = siteVersionBeginRequestSchema.safeParse(request)
  expect(result.success).toBe(accepted)
  if (result.success)
    expect(result.data.preview.window).toEqual(request.preview.window)
})
