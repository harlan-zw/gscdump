import process from 'node:process'
import { cliPapercutBodySchema } from '@gscdump/contracts'
import { z } from 'zod'
import { VERSION } from './utils'

export const DEFAULT_PAPERCUT_BASE_URL = 'https://gscdump.com'
export const PAPERCUT_PATH = '/api/cli/papercuts'
const REQUEST_TIMEOUT_MS = 10_000

export const papercutBodySchema = cliPapercutBodySchema

export type PapercutBody = z.infer<typeof papercutBodySchema>

export interface PapercutReceipt {
  id: string
  status: 'new'
}

export type PapercutResult
  = | { _tag: 'Ok', receipt: PapercutReceipt }
    | { _tag: 'Err', reason: 'invalid_input' | 'rate_limited' | 'rejected' | 'unreachable', message: string }

const receiptSchema = z.object({ id: z.string().min(1), status: z.literal('new') })

export function buildPapercutBody(input: { command: unknown, comment: unknown, agent: unknown, intent?: unknown } & Partial<Record<'requestId' | 'parentRequestId' | 'workflowId' | 'origin' | 'product' | 'surface' | 'operation' | 'skillDigest' | 'skillVersion', unknown>>): { _tag: 'Ok', body: PapercutBody } | { _tag: 'Err', message: string } {
  const parsed = papercutBodySchema.safeParse({
    ...input,
    intent: input.intent ?? 'bug',
    cliVersion: VERSION,
    node: process.versions.node,
    platform: process.platform,
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue?.path.join('.') || 'input'
    return { _tag: 'Err', message: `${field}: ${issue?.message ?? 'invalid'}` }
  }
  return { _tag: 'Ok', body: parsed.data }
}

export function resolvePapercutUrl(environment: Record<string, string | undefined>): string {
  const base = (environment.GSCDUMP_API_URL || DEFAULT_PAPERCUT_BASE_URL).replace(/\/+$/, '')
  return `${base}${PAPERCUT_PATH}`
}

/**
 * One POST, no retry. A papercut is a low-value write and a retry can duplicate
 * it; the skill tells agents to mention a failure and move on.
 */
export async function submitPapercut(
  body: PapercutBody,
  deps: { fetch: typeof fetch, url: string },
): Promise<PapercutResult> {
  const response = await deps.fetch(deps.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-cli-version': body.cliVersion,
      'user-agent': `gscdump-cli/${body.cliVersion}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((cause: unknown) => ({ _tag: 'FetchFailed' as const, cause }))

  if ('_tag' in response) {
    const detail = response.cause instanceof Error ? response.cause.message : String(response.cause)
    return { _tag: 'Err', reason: 'unreachable', message: `Could not reach ${deps.url}: ${detail}` }
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    return {
      _tag: 'Err',
      reason: 'rate_limited',
      message: `Papercut limit reached. Try again in ${retryAfter ? `${retryAfter}s` : 'an hour'}.`,
    }
  }
  if (response.status === 400 || response.status === 422) {
    const text = await response.text()
    return { _tag: 'Err', reason: 'invalid_input', message: `gscdump.com rejected the papercut: ${text.slice(0, 300) || response.status}` }
  }
  if (!response.ok)
    return { _tag: 'Err', reason: 'rejected', message: `gscdump.com answered ${response.status}.` }

  const json: unknown = await response.json().catch((cause: unknown) => ({ invalidResponse: cause instanceof Error ? cause.message : String(cause) }))
  const receipt = receiptSchema.safeParse(json)
  if (!receipt.success)
    return { _tag: 'Err', reason: 'rejected', message: 'gscdump.com answered without a papercut id.' }
  return { _tag: 'Ok', receipt: receipt.data }
}
