import { z } from 'zod'
import { defineResponseObject } from './http-core'

export const runReportV1RequestSchema = z.strictObject({
  reportId: z.enum(['health', 'risks', 'opportunities', 'movers', 'growth', 'triage', 'brand', 'pre-publish']),
  period: z.enum(['last-7d', 'last-28d', 'last-30d', 'last-90d', 'last-180d', 'last-365d', 'mtd', 'qtd', 'ytd', 'last-quarter', 'custom']).optional(),
  comparison: z.enum(['none', 'prev-period', 'yoy']).optional(),
  start: z.iso.date().optional(),
  end: z.iso.date().optional(),
  target: z.string().min(1).max(2048).optional(),
  targetKind: z.enum(['page', 'query']).optional(),
  brandTerms: z.string().min(1).max(2000).optional(),
  topic: z.string().min(1).max(2000).optional(),
  maxFindings: z.number().int().min(1).max(1000).optional(),
  minClicksChange: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  force: z.boolean().default(false),
}).superRefine((value, context) => {
  if (Boolean(value.start) !== Boolean(value.end) || (value.period === 'custom' && !value.start))
    context.addIssue({ code: 'custom', path: ['start'], message: 'Custom windows require both start and end.' })
  if (value.start && value.end && value.start > value.end)
    context.addIssue({ code: 'custom', path: ['end'], message: 'The end must be on or after the start.' })
  if (value.reportId === 'triage' && (!value.target || !value.targetKind))
    context.addIssue({ code: 'custom', path: ['target'], message: 'Triage requires target and targetKind.' })
  if (value.reportId === 'pre-publish' && !value.topic)
    context.addIssue({ code: 'custom', path: ['topic'], message: 'Pre-publish requires topic.' })
  if (value.reportId !== 'movers' && value.minClicksChange !== undefined)
    context.addIssue({ code: 'custom', path: ['minClicksChange'], message: 'minClicksChange applies to movers.' })
})

const range = z.strictObject({ start: z.iso.date(), end: z.iso.date() })
const finding = z.strictObject({
  entity: z.strictObject({ kind: z.enum(['page', 'query']), value: z.string() }),
  metrics: z.record(z.string(), z.number().finite()),
  delta: z.strictObject({ metric: z.string(), prior: z.number().finite(), current: z.number().finite(), pct: z.number().finite() }).optional(),
  why: z.string().optional(),
})
const section = z.strictObject({
  id: z.string(),
  title: z.string(),
  summary: z.strictObject({ delta: z.number().finite().optional(), direction: z.enum(['up', 'down', 'flat']).optional(), magnitudeLabel: z.string().optional() }),
  coverage: z.enum(['full', 'partial']),
  truncated: z.strictObject({ kept: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  dataUnavailable: z.literal(true).optional(),
  findings: z.array(finding),
})

/** Evidence only. Advice and severity are intentionally outside the hosted data contract. */
export const runReportV1DataSchemas = defineResponseObject({
  site: z.string().min(1),
  generatedAt: z.iso.datetime(),
  cached: z.boolean(),
  window: range.extend({ days: z.number().int().positive(), comparison: range.optional() }),
  meta: z.strictObject({
    durationMs: z.number().nonnegative(),
    rowsScanned: z.number().nonnegative(),
    degraded: z.boolean(),
    steps: z.array(z.strictObject({ key: z.string(), type: z.string(), status: z.enum(['pending', 'running', 'done', 'skipped', 'error']), error: z.string().optional(), coverage: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('complete') }), z.strictObject({ kind: z.literal('truncated'), fetched: z.number().int().nonnegative() })]).optional() })),
  }),
  sections: z.array(section),
})

export type RunReportV1Request = z.input<typeof runReportV1RequestSchema>
export type RunReportV1Data = z.infer<typeof runReportV1DataSchemas.client>
