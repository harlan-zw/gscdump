import process from 'node:process'
import { defineCommand } from 'citty'
import { getConfigPath, loadConfig, saveConfig } from '../config'
import { logger } from '../utils'

const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show current config',
  },
  async run() {
    const config = await loadConfig()
    const configPath = getConfigPath()

    logger.info(`Config: ${configPath}`)
    console.log()

    if (Object.keys(config).length === 0) {
      logger.warn('No config set')
      return
    }

    console.log(JSON.stringify(config, null, 2))
  },
})

const setCommand = defineCommand({
  meta: {
    name: 'set',
    description: 'Set a config value',
  },
  args: {
    key: {
      type: 'positional',
      description: 'Config key (defaultSite, defaultPeriod, defaultFormat, defaultDb)',
      required: true,
    },
    value: {
      type: 'positional',
      description: 'Value to set',
      required: true,
    },
  },
  async run({ args }) {
    const validKeys = ['defaultSite', 'defaultPeriod', 'defaultFormat', 'defaultDb']
    if (!validKeys.includes(args.key)) {
      logger.error(`Invalid key: ${args.key}`)
      logger.info(`Valid keys: ${validKeys.join(', ')}`)
      process.exit(1)
    }

    const config = await loadConfig()
      ; (config as any)[args.key] = args.value
    await saveConfig(config)

    logger.success(`Set ${args.key} = ${args.value}`)
  },
})

const unsetCommand = defineCommand({
  meta: {
    name: 'unset',
    description: 'Remove a config value',
  },
  args: {
    key: {
      type: 'positional',
      description: 'Config key to remove',
      required: true,
    },
  },
  async run({ args }) {
    const config = await loadConfig()
    delete (config as any)[args.key]
    await saveConfig(config)

    logger.success(`Removed ${args.key}`)
  },
})

const pathCommand = defineCommand({
  meta: {
    name: 'path',
    description: 'Show config file path',
  },
  run() {
    console.log(getConfigPath())
  },
})

export const configCommand = defineCommand({
  meta: {
    name: 'config',
    description: 'Manage configuration',
  },
  subCommands: {
    show: showCommand,
    set: setCommand,
    unset: unsetCommand,
    path: pathCommand,
  },
})
