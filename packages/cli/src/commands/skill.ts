import os from 'node:os'
import process from 'node:process'
import { defineCommand } from 'citty'
import { skillCommandMeta } from '../command-meta'
import { installSkill, SKILL_AGENTS, SKILL_NAME } from '../skill'
import { applyOutputMode, displayPath, logger, OUTPUT_ARGS } from '../utils'

const installCommand = defineCommand({
  meta: {
    name: 'install',
    description: `Copy the ${SKILL_NAME} skill into an agent skill directory`,
  },
  args: {
    agent: { type: 'string', description: `Agent skill directory: ${SKILL_AGENTS.join(' or ')} (default claude)`, default: 'claude' },
    target: { type: 'string', description: 'Write into this directory instead of the agent home directory' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const agent = SKILL_AGENTS.find(name => name === args.agent)
    if (!agent) {
      logger.error(`Unknown agent "${args.agent}". Use ${SKILL_AGENTS.join(' or ')}.`)
      process.exit(2)
    }
    const result = await installSkill({ agent, homeDirectory: os.homedir(), target: args.target })
    if (result._tag === 'Err') {
      logger.error(result.message)
      process.exit(1)
    }
    if (json) {
      console.log(JSON.stringify(result.installation))
      return
    }
    logger.success(`Installed the ${SKILL_NAME} skill for ${agent} at ${displayPath(result.installation.destination)}`)
    logger.info('Read its SKILL.md before running other commands.')
  },
})

export const skillCommand = defineCommand({
  meta: skillCommandMeta,
  subCommands: {
    install: installCommand,
  },
})
