import type { AgentRequestContext } from '@gscdump/contracts'
import { agentRequestContextSchema } from '@gscdump/contracts'
import { VERSION } from './utils'

/** Optional declared identifiers. Never capture arguments, customer content, or credentials. */
export function hostedRequestContext(environment: Record<string, string | undefined>): AgentRequestContext {
  return agentRequestContextSchema.parse({
    cliVersion: VERSION,
    client: 'gscdump-cli',
    product: environment.GSCDUMP_PRODUCT ?? 'gscdump',
    workflowId: environment.GSCDUMP_WORKFLOW_ID,
    parentRequestId: environment.GSCDUMP_PARENT_REQUEST_ID,
    skillDigest: environment.GSCDUMP_SKILL_DIGEST,
  })
}
