import { z } from 'zod'
import { defineResponseObject } from './http-core'

/**
 * Chart annotations for gscdump time-series charts.
 *
 * - `custom`: user-authored rows in `site_annotations` (editable)
 * - `algo-update`: Google Search ranking updates mirrored from status.search.google.com (read-only)
 */
export const ANNOTATION_CATEGORIES = ['custom', 'algo-update'] as const
export type AnnotationCategory = (typeof ANNOTATION_CATEGORIES)[number]

export const ANNOTATION_TONES = ['success', 'error', 'warning', 'neutral'] as const
export type AnnotationTone = (typeof ANNOTATION_TONES)[number]

/** Calendar day (`YYYY-MM-DD`) so markers stay on the same day across timezones. */
export const annotationDateV1Schema = z.iso.date({ error: 'Use a valid YYYY-MM-DD date.' })

/** Allow only http(s) URLs because annotations render clickable links and agents can write them. */
export const annotationUrlV1Schema = z.url({ error: 'Use a valid http or https URL.' })
  .max(500)
  .refine(url => /^https?:\/\//i.test(url), { message: 'Use an http or https URL.' })

export const annotationIdV1Schema = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid annotation ID.')

export const chartAnnotationsQueryV1Schema = z.strictObject({
  startDate: annotationDateV1Schema.optional(),
  endDate: annotationDateV1Schema.optional(),
}).refine(
  value => !value.startDate || !value.endDate || value.startDate <= value.endDate,
  { message: 'startDate must be on or before endDate.', path: ['endDate'] },
)

export const createSiteAnnotationV1Schema = z.strictObject({
  date: annotationDateV1Schema,
  title: z.string().trim().min(1, 'Title is required.').max(120, 'Title must be 120 characters or fewer.'),
  note: z.string().trim().max(1000, 'Note must be 1000 characters or fewer.').optional(),
  url: annotationUrlV1Schema.optional(),
})

export const updateSiteAnnotationV1Schema = z.strictObject({
  date: annotationDateV1Schema.optional(),
  title: z.string().trim().min(1, 'Title is required.').max(120, 'Title must be 120 characters or fewer.').optional(),
  note: z.string().trim().max(1000, 'Note must be 1000 characters or fewer.').nullish(),
  url: annotationUrlV1Schema.nullish(),
}).refine(
  body => Object.values(body).some(value => value !== undefined),
  { message: 'Provide at least one field to update.' },
)

export const siteAnnotationV1Schemas = defineResponseObject({
  id: z.string(),
  siteId: z.string(),
  date: annotationDateV1Schema,
  title: z.string(),
  note: z.string().nullish(),
  url: z.string().nullish(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const siteAnnotationListV1Schemas = defineResponseObject(
  { annotations: z.array(siteAnnotationV1Schemas.producer) },
  { annotations: z.array(siteAnnotationV1Schemas.client) },
)

export const siteAnnotationMutationV1Schemas = defineResponseObject(
  { annotation: siteAnnotationV1Schemas.producer },
  { annotation: siteAnnotationV1Schemas.client },
)

export const siteAnnotationDeleteV1Schemas = defineResponseObject({
  deleted: z.boolean(),
  id: z.string(),
})

export const chartAnnotationItemV1Schemas = defineResponseObject({
  id: z.string(),
  date: annotationDateV1Schema,
  label: z.string(),
  description: z.string().optional(),
  href: annotationUrlV1Schema.optional(),
  category: z.enum(ANNOTATION_CATEGORIES),
  tone: z.enum(ANNOTATION_TONES).default('neutral'),
  editable: z.boolean(),
})

export const chartAnnotationsV1Schemas = defineResponseObject(
  { annotations: z.array(chartAnnotationItemV1Schemas.producer) },
  { annotations: z.array(chartAnnotationItemV1Schemas.client) },
)

export type ChartAnnotationsQueryV1 = z.infer<typeof chartAnnotationsQueryV1Schema>
export type ChartAnnotationItemV1 = z.infer<typeof chartAnnotationItemV1Schemas.producer>
export type ChartAnnotationsV1 = z.infer<typeof chartAnnotationsV1Schemas.producer>
export type CreateSiteAnnotationV1Input = z.infer<typeof createSiteAnnotationV1Schema>
export type UpdateSiteAnnotationV1Input = z.infer<typeof updateSiteAnnotationV1Schema>
export type SiteAnnotationV1 = z.infer<typeof siteAnnotationV1Schemas.producer>
export type SiteAnnotationListV1 = z.infer<typeof siteAnnotationListV1Schemas.producer>
export type SiteAnnotationMutationV1 = z.infer<typeof siteAnnotationMutationV1Schemas.producer>
export type SiteAnnotationDeleteV1 = z.infer<typeof siteAnnotationDeleteV1Schemas.producer>
