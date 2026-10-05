import { z } from 'zod'
import { searchTypeSchema } from '../schemas'
import { defineResponseObject } from './http-core'

export const analyticsCoverageQueryV1Schema = z.strictObject({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  comparisonStartDate: z.iso.date().optional(),
  comparisonEndDate: z.iso.date().optional(),
  searchType: searchTypeSchema.default('web'),
}).refine(input => input.startDate <= input.endDate, 'The start date must precede the end date.').refine(input => (input.comparisonStartDate === undefined) === (input.comparisonEndDate === undefined), 'Provide both comparison dates.').refine(input => !input.comparisonStartDate || input.comparisonStartDate <= input.comparisonEndDate!, 'The comparison start date must precede the end date.')

const window = defineResponseObject({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  complete: z.boolean(),
})

export const analyticsCoverageV1Schemas = defineResponseObject({
  searchType: searchTypeSchema,
  current: window.producer,
  comparison: window.producer.nullable(),
}, {
  searchType: searchTypeSchema,
  current: window.client,
  comparison: window.client.nullable(),
})

export type AnalyticsCoverageV1 = z.output<typeof analyticsCoverageV1Schemas.client>
