#!/usr/bin/env node

import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { analyzeCommand } from './commands/analyze'
import { authCommand } from './commands/auth'
import { compareCommand } from './commands/compare'
import { configCommand } from './commands/config'
import { dumpCommand } from './commands/dump'
import { indexingCommand, inspectCommand } from './commands/indexing'
import { initCommand } from './commands/init'
import { mcpCommand } from './commands/mcp'
import { sitemapsCommand } from './commands/sitemaps'
import { sitesCommand } from './commands/sites'
import { syncCommand } from './commands/sync'
import { showSplash, VERSION } from './utils'

const main = defineCommand({
  meta: {
    name: 'gscdump',
    version: VERSION,
    description: 'Google Search Console Data Extractor',
  },
  subCommands: {
    init: initCommand,
    dump: dumpCommand,
    sync: syncCommand,
    compare: compareCommand,
    analyze: analyzeCommand,
    sites: sitesCommand,
    sitemaps: sitemapsCommand,
    index: indexingCommand,
    inspect: inspectCommand,
    auth: authCommand,
    config: configCommand,
    mcp: mcpCommand,
  },
  setup() {
    // Skip splash for MCP mode - stdout is used for protocol
    if (!process.argv.includes('mcp')) {
      showSplash()
    }
  },
  async run({ args }) {
    // If no subcommand, run dump (interactive or non-interactive based on args)
    if (!args._.length) {
      await dumpCommand.run!({ args: args as never, rawArgs: [], cmd: dumpCommand })
    }
  },
})

runMain(main)
