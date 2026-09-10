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
    command: { type: 'string', description: 'The gscdump command that misbehaved, for example "report triage"' },
    comment: { type: 'string', description: 'What you ran, what you expected, what happened, any workaround (sanitized)' },
    agent: { type: 'string', description: 'Reporter name, for example "Claude Code" or a person\'s handle' },
    intent: { type: 'string', description: 'bug (default) or improvement', default: 'bug' },
    yes: { type: 'boolean', alias: 'y', default: false, description: 'Submit without confirmation' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const built = buildPapercutBody({
      command: args.command,
      comment: args.comment,
      agent: args.agent,
      intent: args.intent,
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
    if (result._tag === 'Err') {
      logger.error(result.message)
      process.exit(1)
    }

    if (json) {
      console.log(JSON.stringify(result.receipt))
      return
    }
    logger.success(`Papercut saved: ${result.receipt.id} (${result.receipt.status})`)
  },
})
