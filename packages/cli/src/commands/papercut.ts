import process from 'node:process'
import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'
import { papercutCommandMeta } from '../command-meta'
import { buildPapercutBody, resolvePapercutUrl, submitPapercut } from '../papercut'
import { useCliRuntime } from '../runtime'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

export const papercutCommand = defineCommand({
  meta: papercutCommandMeta,
  args: {
    'command': { type: 'string', description: 'The gscdump command that misbehaved, for example "report triage"' },
    'comment': { type: 'string', description: 'What you ran, what you expected, what happened, any workaround (sanitized)' },
    'agent': { type: 'string', description: 'Reporter name, for example "Claude Code" or a person\'s handle' },
    'intent': { type: 'string', description: 'bug (default) or improvement', default: 'bug' },
    'request-id': { type: 'string', description: 'Request ID returned by the failed operation' },
    'parent-request-id': { type: 'string', description: 'Request ID returned by the calling application' },
    'workflow-id': { type: 'string', description: 'Opaque task identifier without customer content' },
    'origin': { type: 'string', description: 'Application host, for example requestindexing.com' },
    'product': { type: 'string', description: 'Application identifier' },
    'surface': { type: 'string', description: 'cli, mcp, api, skill, or browser' },
    'operation': { type: 'string', description: 'Operation identifier' },
    'skill-digest': { type: 'string', description: 'SHA-256 digest of the skill artifact' },
    'skill-version': { type: 'string', description: 'Declared skill version' },
    'yes': { type: 'boolean', alias: 'y', default: false, description: 'Submit without confirmation' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const built = buildPapercutBody({
      command: args.command,
      comment: args.comment,
      agent: args.agent,
      intent: args.intent,
      requestId: args['request-id'],
      parentRequestId: args['parent-request-id'],
      workflowId: args['workflow-id'],
      origin: args.origin,
      product: args.product,
      surface: args.surface,
      operation: args.operation,
      skillDigest: args['skill-digest'],
      skillVersion: args['skill-version'],
    })
    if (built._tag === 'Err') {
      logger.error(`Invalid papercut: ${built.message}`)
      logger.info('Pass --command, --comment, and --agent. Read `gscdump papercut --help` for limits.')
      process.exit(2)
    }

    if (!args.yes) {
      if (!process.stdin.isTTY || json) {
        logger.error('Pass --yes to submit without a prompt.')
        process.exit(2)
      }
      const ok = await confirm({ message: `Send this papercut about "${built.body.command}" to gscdump.com?` })
      if (isCancel(ok) || !ok) {
        logger.info('Papercut cancelled.')
        process.exit(0)
      }
    }

    const url = resolvePapercutUrl(useCliRuntime().environment)
    const result = await submitPapercut(built.body, { fetch: globalThis.fetch, url })
    if (result._tag === 'Err')
      throw new Error(result.message)

    if (json) {
      console.log(JSON.stringify(result.receipt))
      return
    }
    logger.success(`Papercut saved: ${result.receipt.id} (${result.receipt.status})`)
  },
})
