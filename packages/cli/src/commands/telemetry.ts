import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { confirm, isCancel } from '@clack/prompts'
import { agentOutcomeBodySchema } from '@gscdump/contracts'
import { defineCommand } from 'citty'
import { submitAgentOutcome } from '../agent-outcome'
import { hostedCredential, resolveAuthentication } from '../auth-state'
import { resolvePapercutUrl } from '../papercut'
import { useCliRuntime } from '../runtime'
import { applyOutputMode, OUTPUT_ARGS, VERSION } from '../utils'

export const telemetryCommand = defineCommand({
  meta: { name: 'telemetry', description: 'Record an explicit agent task outcome' },
  subCommands: {
    record: defineCommand({
      meta: { name: 'record', description: 'Submit bounded task metadata without prompts or output bodies' },
      args: {
        'event-id': { type: 'string', description: 'Stable event ID; defaults to a new UUID' },
        'workflow-id': { type: 'string', required: true, description: 'Opaque task identifier' },
        'request-id': { type: 'string', description: 'Related server request ID' },
        'parent-request-id': { type: 'string', description: 'Related consumer request ID' },
        'product': { type: 'string', default: 'gscdump', description: 'Declared originating application' },
        'surface': { type: 'string', default: 'cli', description: 'cli, mcp, api, skill, or browser' },
        'operation': { type: 'string', required: true, description: 'Operation identifier without arguments' },
        'step': { type: 'string', default: 'complete', description: 'setup, read, diagnose, fix, verify, or complete' },
        'outcome': { type: 'string', required: true, description: 'success, failure, blocked, or cancelled' },
        'semantic-flags': { type: 'string', description: 'Comma-separated empty, unavailable, refused, provisional, partial, stale, truncated' },
        'row-count': { type: 'string', description: 'Measured domain row count' },
        'duration-ms': { type: 'string', description: 'Measured task duration' },
        'quality': { type: 'string', default: 'unknown', description: 'Declared useful, unusable, incorrect, or unknown' },
        'error-code': { type: 'string', description: 'Stable error code' },
        'skill-digest': { type: 'string', description: 'SHA-256 digest of the skill artifact' },
        'skill-version': { type: 'string', description: 'Declared skill version' },
        'yes': { type: 'boolean', alias: 'y', default: false, description: 'Submit without confirmation' },
        ...OUTPUT_ARGS,
      },
      async run({ args }) {
        const { json } = applyOutputMode(args)
        const body = agentOutcomeBodySchema.parse({
          eventId: args['event-id'] || randomUUID(),
          workflowId: args['workflow-id'],
          requestId: args['request-id'],
          parentRequestId: args['parent-request-id'],
          product: args.product,
          surface: args.surface,
          operation: args.operation,
          step: args.step,
          outcome: args.outcome,
          semanticFlags: args['semantic-flags'] ? args['semantic-flags'].split(',').map(flag => flag.trim()) : [],
          rowCount: args['row-count'] !== undefined ? Number(args['row-count']) : undefined,
          durationMs: args['duration-ms'] !== undefined ? Number(args['duration-ms']) : undefined,
          quality: args.quality,
          errorCode: args['error-code'],
          skillDigest: args['skill-digest'],
          skillVersion: args['skill-version'],
          cliVersion: VERSION,
        })
        if (!args.yes) {
          if (!process.stdin.isTTY || json)
            throw new Error('Pass --yes to submit this declared task outcome.')
          const accepted = await confirm({ message: 'Submit this declared agent task outcome?' })
          if (isCancel(accepted) || !accepted)
            return
        }
        const runtime = useCliRuntime()
        const url = resolvePapercutUrl(runtime.environment).replace(/\/papercuts$/, '/agent-outcomes')
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Hosted' && new URL(url).origin !== new URL(authentication.apiRoot).origin)
          throw new Error('The outcome endpoint does not match the Hosted credential origin.')
        const credential = authentication._tag === 'Hosted' ? hostedCredential(authentication) : undefined
        const result = await submitAgentOutcome(body, { fetch: globalThis.fetch, url, credential })
        if (result._tag === 'Err')
          throw new Error(result.message)
        console.log(JSON.stringify(result.receipt))
      },
    }),
  },
})
