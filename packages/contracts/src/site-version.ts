import { z } from 'zod'
import { searchTypeSchema } from './schemas'

/** Partner control-plane identity. Numeric identity is the effective writer key. */
const registeredUrl = z.url().refine((value) => {
  const url = new URL(value)
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
    && !url.hash && !url.search && url.pathname === '/'
}, { message: 'Use an HTTP or HTTPS host URL without a path, query, or fragment.' })

export const siteVersionIdentitySchema = z.strictObject({
  siteId: z.string().regex(/^s_[\w-]+$/),
  userId: z.string().regex(/^u_[\w-]+$/),
  teamId: z.union([z.uuid(), z.string().regex(/^t_[\w-]+$/)]),
  requestedUrl: registeredUrl,
  catalogSiteId: z.number().int().positive(),
  warehouse: z.string().min(1),
  namespace: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  catalogRevision: z.number().int().nonnegative(),
})

export const siteVersionWindowSchema = z.strictObject({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
}).refine((window) => {
  const days = (Date.parse(window.endDate) - Date.parse(window.startDate)) / 86_400_000
  return days >= 0
}, {
  message: 'The end date must follow or equal the start date.',
})

const collectionWindow = siteVersionWindowSchema.refine(
  window => (Date.parse(window.endDate) - Date.parse(window.startDate)) / 86_400_000 < 56,
  { message: 'The collection window must contain 1 to 56 days.' },
)

const reportWindow = siteVersionWindowSchema.refine(
  window => (Date.parse(window.endDate) - Date.parse(window.startDate)) / 86_400_000 === 27,
  { message: 'The report window must contain 28 days.' },
)

export const siteVersionSliceSchema = z.strictObject({
  table: z.enum([
    'dates',
    'pages',
    'queries',
    'countries',
    'page_queries',
    'search_appearance',
    'search_appearance_pages',
    'search_appearance_queries',
    'search_appearance_page_queries',
    'hourly_pages',
  ]),
  searchType: searchTypeSchema,
})

export const siteVersionPreviewRequestSchema = z.strictObject({
  requestedUrl: registeredUrl,
  catalogSiteId: z.number().int().positive(),
  window: reportWindow,
})

const eligible = z.strictObject({
  _tag: z.literal('eligible'),
  identity: siteVersionIdentitySchema,
  requestedUrl: registeredUrl,
  window: collectionWindow,
  requiredSlices: z.array(siteVersionSliceSchema).min(1),
  candidateNamespace: z.string().regex(/^[a-z][a-z0-9_]*$/),
  candidateVersion: z.number().int().positive(),
})

export const siteVersionRefusalSchema = z.enum([
  'catalog-identity-mismatch',
  'identity-changed',
  'host-reserved',
  'not-eligible',
  'property-unavailable',
  'catalog-unavailable',
  'provisioning-incomplete',
  'coverage-incomplete',
  'candidate-aborted',
  'candidate-failed',
])

export const siteVersionPreviewSchema = z.discriminatedUnion('_tag', [
  eligible,
  z.strictObject({
    _tag: z.literal('blocked'),
    reason: siteVersionRefusalSchema,
  }),
])

export const siteVersionBeginRequestSchema = z.strictObject({ preview: eligible })
export const siteVersionCandidateRequestSchema = z.strictObject({
  version: z.number().int().positive(),
  identity: siteVersionIdentitySchema,
})

const candidate = z.strictObject({
  version: z.number().int().positive(),
  namespace: z.string().regex(/^[a-z][a-z0-9_]*$/),
  requestedUrl: registeredUrl,
  window: collectionWindow,
  requiredSlices: z.array(siteVersionSliceSchema).min(1),
})

export const siteVersionCandidateSchema = z.discriminatedUnion('state', [
  candidate.extend({ state: z.literal('collecting') }),
  candidate.extend({ state: z.literal('verified') }),
  candidate.extend({ state: z.literal('active') }),
  candidate.extend({ state: z.literal('aborted') }),
  candidate.extend({ state: z.literal('failed'), failure: siteVersionRefusalSchema }),
])

export const siteVersionIdentityResponseSchema = z.strictObject({
  identity: siteVersionIdentitySchema,
  coverage: z.discriminatedUnion('_tag', [
    z.strictObject({ _tag: z.literal('legacy') }),
    z.strictObject({ _tag: z.literal('verified'), window: siteVersionWindowSchema }),
  ]),
})

export type SiteVersionIdentity = z.infer<typeof siteVersionIdentitySchema>
export type SiteVersionIdentityResponse = z.infer<typeof siteVersionIdentityResponseSchema>
export type SiteVersionPreview = z.infer<typeof siteVersionPreviewSchema>
export type SiteVersionCandidate = z.infer<typeof siteVersionCandidateSchema>
export type SiteVersionWindow = z.infer<typeof siteVersionWindowSchema>
export type SiteVersionSlice = z.infer<typeof siteVersionSliceSchema>
