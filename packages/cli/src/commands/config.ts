import process from 'node:process'
import { defineCommand } from 'citty'
import { getConfigPath, loadConfig, saveConfig } from '../config'
import { displayPath, logger, setQuiet } from '../utils'

const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show current config',
  },
  args: {
    json: { type: 'boolean', default: false, description: 'Output config as a single JSON object (suppresses path header)' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const config = await loadConfig()
    const configPath = getConfigPath()

    if (args.json) {
      console.log(JSON.stringify({ path: configPath, config }, null, 2))
      return
    }

    logger.info(`Config: ${displayPath(configPath)}`)
    console.log()

    if (Object.keys(config).length === 0) {
      logger.warn('No config set')
      return
    }

    console.log(JSON.stringify(config, null, 2))
  },
})

const VALID_KEYS = [
  'defaultSite',
  'defaultPeriod',
  'defaultFormat',
  'defaultDb',
  'dataDir',
  'defaultLimit',
  'defaultSearchType',
  'defaultDataState',
] as const

const NUMERIC_KEYS = new Set(['defaultLimit'])

const setCommand = defineCommand({
  meta: {
    name: 'set',
    description: 'Set a config value',
  },
  args: {
    key: {
      type: 'positional',
      description: `Config key (${VALID_KEYS.join(', ')})`,
      required: true,
    },
    value: {
      type: 'positional',
      description: 'Value to set',
      required: true,
    },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet))
    if (!(VALID_KEYS as readonly string[]).includes(args.key)) {
      logger.error(`Invalid key: ${args.key}`)
      logger.info(`Valid keys: ${VALID_KEYS.join(', ')}`)
      process.exit(1)
    }

    const config = await loadConfig()
    const value: string | number = NUMERIC_KEYS.has(args.key) ? Number(args.value) : args.value
    if (NUMERIC_KEYS.has(args.key) && !Number.isFinite(value)) {
      logger.error(`Invalid numeric value for ${args.key}: ${args.value}`)
      process.exit(1)
    }
    ;(config as any)[args.key] = value
    await saveConfig(config)

    logger.success(`Set ${args.key} = ${value}`)
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
      description: `Config key to remove (${VALID_KEYS.join(', ')})`,
      required: true,
    },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet))
    if (!(VALID_KEYS as readonly string[]).includes(args.key)) {
      logger.error(`Invalid key: ${args.key}`)
      logger.info(`Valid keys: ${VALID_KEYS.join(', ')}`)
      process.exit(1)
    }
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

const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate the saved config (defaultSite is verified, dataDir exists/writable)',
  },
  args: {
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const { resolveDataDir } = await import('../config')
    const fs = await import('node:fs/promises')
    const config = await loadConfig()
    const issues: Array<{ key: string, level: 'fail' | 'warn', message: string }> = []

    // dataDir: must exist (or be createable) and be writable.
    const dataDir = resolveDataDir(config)
    const dataDirDisplay = displayPath(dataDir)
    const stat = await fs.stat(dataDir).catch(() => null)
    if (stat && !stat.isDirectory()) {
      issues.push({ key: 'dataDir', level: 'fail', message: `${dataDirDisplay} is not a directory` })
    }
    else if (stat) {
      const probe = `${dataDir}/.gscdump-config-probe`
      const writable = await fs.writeFile(probe, '').then(() => fs.rm(probe)).then(() => true).catch(() => false)
      if (!writable)
        issues.push({ key: 'dataDir', level: 'fail', message: `${dataDirDisplay} not writable` })
    }
    else {
      issues.push({ key: 'dataDir', level: 'warn', message: `${dataDirDisplay} does not exist (will be created on first sync)` })
    }

    // defaultSite: best-effort check against the verified site list. Skip
    // when no auth is configured (we can't list sites yet).
    if (config.defaultSite) {
      const haveAuth = !!config.clientId && !!config.clientSecret
      if (haveAuth) {
        const { createCommandContext } = await import('../context')
        const ctx = await createCommandContext({ needsAuth: true }).catch(() => null)
        if (ctx) {
          const sites = await ctx.loadSites().catch(() => null)
          if (sites && !sites.some(s => s.siteUrl === config.defaultSite || s.siteUrl.includes(String(config.defaultSite))))
            issues.push({ key: 'defaultSite', level: 'fail', message: `${config.defaultSite} is not in the verified site list` })
        }
      }
      else {
        issues.push({ key: 'defaultSite', level: 'warn', message: 'set, but auth not configured — skipping verification' })
      }
    }

    // Enum-style values: check known constants.
    if (config.defaultFormat && !['json', 'csv'].includes(config.defaultFormat))
      issues.push({ key: 'defaultFormat', level: 'fail', message: `unknown format: ${config.defaultFormat}` })

    if (args.json) {
      console.log(JSON.stringify({ ok: !issues.some(i => i.level === 'fail'), issues }, null, 2))
      return
    }
    if (issues.length === 0) {
      logger.success('Config OK')
      return
    }
    for (const i of issues) {
      const prefix = i.level === 'fail' ? '\x1B[31m✗\x1B[0m' : '\x1B[33m!\x1B[0m'
      console.log(`  ${prefix} ${i.key}: ${i.message}`)
    }
    if (issues.some(i => i.level === 'fail'))
      process.exit(1)
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
    validate: validateCommand,
  },
})
