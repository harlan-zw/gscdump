import type { AgentOutcomeBody, AgentOutcomeReceipt } from '@gscdump/contracts'
import { agentOutcomeReceiptSchema } from '@gscdump/contracts'

export type AgentOutcomeResult
  = | { _tag: 'Ok', receipt: AgentOutcomeReceipt }
    | { _tag: 'Err', reason: 'unreachable' | 'rejected', message: string }

/** One explicit write, no retries. Never send local command arguments or output bodies. */
export async function submitAgentOutcome(body: AgentOutcomeBody, deps: { fetch: typeof fetch, url: string, credential?: string }): Promise<AgentOutcomeResult> {
  const response = await deps.fetch(deps.url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...(deps.credential ? { authorization: `Bearer ${deps.credential}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch((cause: unknown) => ({ _tag: 'FetchFailed' as const, cause }))
  if ('_tag' in response)
    return { _tag: 'Err', reason: 'unreachable', message: 'Could not reach the outcome endpoint. Do not retry an uncertain submission.' }
  if (!response.ok)
    return { _tag: 'Err', reason: 'rejected', message: `Outcome reporting returned HTTP ${response.status}.` }
  const data: unknown = await response.json().catch((cause: unknown) => ({ invalidResponse: cause instanceof Error ? cause.message : String(cause) }))
  const parsed = agentOutcomeReceiptSchema.safeParse(data)
  if (!parsed.success)
    return { _tag: 'Err', reason: 'rejected', message: 'The outcome endpoint returned an invalid receipt.' }
  return { _tag: 'Ok', receipt: parsed.data }
}
