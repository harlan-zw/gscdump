import { z } from 'zod'
import { defineResponseObject } from './http-core'

const parquetMediaType = 'application/vnd.apache.parquet'

export const recordExportFileV1Schema = z.string().max(100).regex(/^[a-z][a-z0-9_]*\.parquet$/)

const column = z.object({
  name: z.string(),
  type: z.enum(['VARCHAR', 'DATE', 'BIGINT', 'INTEGER', 'DOUBLE']),
  nullable: z.boolean(),
  description: z.string(),
})

const dataset = z.object({
  dataset: z.string(),
  file: recordExportFileV1Schema,
  description: z.string(),
  coverage: z.string(),
  columns: z.array(column),
})

export const recordExportManifestV1Schemas = defineResponseObject({
  generatedAt: z.iso.datetime(),
  format: z.literal('parquet'),
  siteId: z.string(),
  siteUrl: z.url(),
  datasets: z.array(dataset),
})

const parquet = z.instanceof(Response).refine(
  response => response.body !== null && response.headers.get('content-type')?.split(';')[0] === parquetMediaType,
  'Expected a Parquet download',
)

export const recordExportParquetV1Response = { producer: parquet, client: parquet, mediaType: parquetMediaType }
